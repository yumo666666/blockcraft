package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/getlantern/systray"
)

//go:embed blockcraft.ico
var trayIcon []byte

type panelFile struct {
	Panel struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
	} `json:"panel"`
	Frp struct {
		AdminPortPanel  int `json:"adminPortPanel"`
		AdminPortWorlds int `json:"adminPortWorlds"`
	} `json:"frp"`
}

func showError(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("BlockCraft 启动失败")
	proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	proc.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}

func readPanelConfig(file string) panelFile {
	var config panelFile
	data, err := os.ReadFile(file)
	if err == nil {
		_ = json.Unmarshal(data, &config)
	}
	return config
}

func panelConnection(dataDir string) (int, string) {
	config := readPanelConfig(filepath.Join(dataDir, "panel.json"))
	port := config.Panel.Port
	if value := os.Getenv("BC_PORT"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
			port = parsed
		}
	}
	if port < 1 {
		port = 8081
	}
	return port, config.Panel.Token
}

func sameWindowsPath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	a, errA := filepath.Abs(filepath.Clean(a))
	b, errB := filepath.Abs(filepath.Clean(b))
	return errA == nil && errB == nil && strings.EqualFold(a, b)
}

func logLauncher(file *os.File, format string, args ...any) {
	if file == nil {
		return
	}
	line := fmt.Sprintf(format, args...)
	_, _ = fmt.Fprintf(file, "%s [launcher] %s\n", time.Now().Format("2006-01-02 15:04:05"), line)
}

func panelDataDirectory(dataDir string) (string, error) {
	port, token := panelConnection(dataDir)
	if token == "" {
		return "", fmt.Errorf("没有找到面板令牌")
	}
	var response struct {
		DataDir string `json:"dataDir"`
	}
	if err := trayPanelGetJSON(port, token, "/api/panel", 10*time.Second, &response); err != nil {
		return "", err
	}
	if response.DataDir == "" {
		return "", fmt.Errorf("面板没有返回数据目录")
	}
	return response.DataDir, nil
}

func browserURL(dataDir string) (string, bool) {
	port, token := panelConnection(dataDir)
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/ping", port), nil)
	if err != nil {
		return "", false
	}
	client := &http.Client{Timeout: 1200 * time.Millisecond, Transport: &http.Transport{Proxy: nil}}
	response, err := client.Do(request)
	if err != nil {
		return "", false
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", false
	}
	panelURL := fmt.Sprintf("http://127.0.0.1:%d/", port)
	if token != "" {
		panelURL += "?token=" + neturl.QueryEscape(token)
	}
	return panelURL, true
}

func openBrowser(url string) {
	if url == "" {
		return
	}
	_ = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
}

func confirmStopWorldsAndExit() bool {
	message, _ := syscall.UTF16PtrFromString("这会先安全停止所有正在运行的 Minecraft 世界，然后关闭 BlockCraft。\n\n停止过程可能需要一些时间。是否继续？")
	title, _ := syscall.UTF16PtrFromString("关闭 BlockCraft")
	proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	// MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2：默认焦点放在「否」。
	result, _, _ := proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x4|0x30|0x100)
	return result == 6 // IDYES
}

func stopWorldsAndClosePanel(dataDir string) error {
	port, token := panelConnection(dataDir)
	if token == "" {
		return fmt.Errorf("没有找到面板令牌，无法安全关闭世界")
	}
	return trayPanelPost(port, token, "/api/panel/shutdown-after-worlds", 10*time.Minute)
}

func activeWorldNames(dataDir string) ([]string, error) {
	port, token := panelConnection(dataDir)
	if token == "" {
		return nil, fmt.Errorf("没有找到面板令牌，无法确认正在运行的世界")
	}
	var response struct {
		Instances []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"instances"`
	}
	if err := trayPanelGetJSON(port, token, "/api/instances", 15*time.Second, &response); err != nil {
		return nil, err
	}
	worlds := make([]string, 0, len(response.Instances))
	for _, world := range response.Instances {
		switch world.Status {
		case "running", "starting", "stopping", "stuck":
			worlds = append(worlds, world.Name)
		}
	}
	return worlds, nil
}

func restartPanelOnly(dataDir string) error {
	port, token := panelConnection(dataDir)
	if token == "" {
		return fmt.Errorf("没有找到面板令牌，无法安全重启面板")
	}
	return trayPanelPost(port, token, "/api/panel/shutdown", 10*time.Second)
}

// After the panel confirms that all worlds stopped safely, wait for its process
// to exit. If the shutdown response succeeded but Node does not exit, terminate
// only the panel process so the tray cannot disappear while the panel stays up.
func waitForPanelExit(exited <-chan struct{}, process *os.Process, timeout time.Duration) error {
	select {
	case <-exited:
		return nil
	case <-time.After(timeout):
	}

	_ = process.Kill()
	select {
	case <-exited:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("面板服务进程在安全停服后仍未退出")
	}
}

func waitForPanelUnavailable(dataDir string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if _, available := browserURL(dataDir); !available {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func waitForFrpAdminPortsClosed(dataDir string, timeout time.Duration) []int {
	config := readPanelConfig(filepath.Join(dataDir, "panel.json"))
	ports := []int{config.Frp.AdminPortWorlds, config.Frp.AdminPortPanel}
	deadline := time.Now().Add(timeout)
	for {
		var open []int
		for _, port := range ports {
			if port < 1 {
				continue
			}
			connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
			if err == nil {
				open = append(open, port)
				_ = connection.Close()
			}
		}
		if len(open) == 0 || time.Now().After(deadline) {
			return open
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func run() int {
	executable, err := os.Executable()
	if err != nil {
		showError("无法定位 BlockCraft 文件夹。")
		return 1
	}
	releaseDir := filepath.Dir(executable)
	appDir := filepath.Join(releaseDir, "app")
	nodeExe := filepath.Join(releaseDir, "runtime", "node.exe")
	entry := filepath.Join(appDir, "server-runtime", "src", "index.ts")
	if _, err := os.Stat(nodeExe); err != nil {
		showError("缺少 runtime\\node.exe。请重新解压完整的 BlockCraft-Windows-x64.zip。")
		return 1
	}
	if _, err := os.Stat(entry); err != nil {
		showError("缺少服务端文件。请重新解压完整的 BlockCraft-Windows-x64.zip。")
		return 1
	}

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		userHome, _ := os.UserHomeDir()
		localAppData = filepath.Join(userHome, "AppData", "Local")
	}
	legacyUserDir := filepath.Join(localAppData, "BlockCraft")
	dataDir, instanceDir := portableDirectories(releaseDir)
	if err := migrateLegacyData(releaseDir, legacyUserDir); err != nil {
		showError("无法迁移旧数据到便携文件夹：\n" + err.Error() + "\n\n请确认 BlockCraft 文件夹有写入权限。旧数据仍保留在原位置。")
		return 1
	}
	_ = os.MkdirAll(filepath.Join(dataDir, "logs"), 0o755)
	_ = os.MkdirAll(instanceDir, 0o755)
	logFile, err := os.OpenFile(filepath.Join(dataDir, "logs", "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		showError("无法在 BlockCraft 文件夹内创建日志。请检查文件夹是否可写，并避免放在只读目录。")
		return 1
	}
	defer logFile.Close()
	logLauncher(logFile, "启动器启动，PID=%d，数据目录=%s", os.Getpid(), dataDir)
	_ = os.Setenv("BC_ROOT", appDir)
	_ = os.Setenv("BC_DATA_DIR", dataDir)
	_ = os.Setenv("BC_INSTANCE_DIR", instanceDir)
	existingPanel := false
	existingPanelURL := ""
	if url, ok := browserURL(dataDir); ok {
		ownerDataDir, ownerErr := panelDataDirectory(dataDir)
		if ownerErr != nil {
			logLauncher(logFile, "端口已有面板响应，但无法验证归属：%v", ownerErr)
			openBrowser(url)
			showError("本地端口已有 BlockCraft 面板响应，但启动器无法确认它属于当前文件夹。为避免误关另一份面板，未创建托盘控制器。请先关闭占用面板的旧进程后再启动。")
			return 1
		}
		if !sameWindowsPath(ownerDataDir, dataDir) {
			logLauncher(logFile, "端口已被另一份 BlockCraft 占用，当前=%s，响应方=%s", dataDir, ownerDataDir)
			openBrowser(url)
			showError("本地面板端口正由另一份 BlockCraft 数据目录占用。已打开现有面板，但当前启动器不会关闭它。请从对应文件夹启动 BlockCraft，或先关闭旧进程。")
			return 1
		}
		logLauncher(logFile, "发现同一数据目录的遗留面板，将接管托盘控制：%s", ownerDataDir)
		existingPanel = true
		existingPanelURL = url
	}

	var cmd *exec.Cmd
	var wait chan error
	adoptedPanel := existingPanel
	if !adoptedPanel {
		cmd = exec.Command(nodeExe, "--experimental-strip-types", "--use-env-proxy", entry)
		cmd.Dir = appDir
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		if err := cmd.Start(); err != nil {
			logLauncher(logFile, "启动 Node.js 失败：%v", err)
			showError("BlockCraft 服务没有启动。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
			return 1
		}
		wait = make(chan error, 1)
		go func() { wait <- cmd.Wait() }()
		deadline := time.Now().Add(90 * time.Second)
		opened := false
		for time.Now().Before(deadline) {
			select {
			case err := <-wait:
				logLauncher(logFile, "BlockCraft 服务在启动阶段退出：%v", err)
				if err != nil {
					showError("BlockCraft 服务意外退出。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
					return 1
				}
				return 0
			default:
			}
			if url, ok := browserURL(dataDir); ok {
				ownerDataDir, ownerErr := panelDataDirectory(dataDir)
				if ownerErr != nil || !sameWindowsPath(ownerDataDir, dataDir) {
					_ = cmd.Process.Kill()
					logLauncher(logFile, "启动期间端口被其他进程占用：dataDir=%q error=%v", ownerDataDir, ownerErr)
					showError("本地面板端口被另一份程序占用，启动器已停止本次服务启动。请先关闭占用端口的旧面板，再重新启动。")
					return 1
				}
				openBrowser(url)
				opened = true
				break
			}
			time.Sleep(time.Second)
		}
		if !opened {
			_ = cmd.Process.Kill()
			logLauncher(logFile, "等待面板启动超时")
			showError("等待面板启动超时。请检查 BlockCraft 文件夹内 data\\logs\\launcher.log。")
			return 1
		}
	} else {
		openBrowser(existingPanelURL)
	}

	serverExited := make(chan error, 1)
	serverStopped := make(chan struct{})
	trayReady := make(chan struct{})
	var restartAfterExit atomic.Bool
	var shutdownAfterWorldsRequested atomic.Bool
	go func() {
		var err error
		if wait != nil {
			err = <-wait
		} else {
			for !waitForPanelUnavailable(dataDir, 24*time.Hour) {
				time.Sleep(250 * time.Millisecond)
			}
		}
		if err != nil {
			logLauncher(logFile, "BlockCraft 服务退出：%s", strings.TrimSpace(err.Error()))
		} else {
			logLauncher(logFile, "BlockCraft 面板服务已退出")
		}
		serverExited <- err
		close(serverStopped)
		<-trayReady
		if restartAfterExit.Load() {
			systray.Quit()
			return
		}
		if shutdownAfterWorldsRequested.Load() {
			return
		}
		if _, stillResponding := browserURL(dataDir); stillResponding {
			message, _ := syscall.UTF16PtrFromString("BlockCraft 面板服务进程已退出，但本地地址仍有其他进程响应。托盘保持运行，请检查端口对应的进程。")
			title, _ := syscall.UTF16PtrFromString("BlockCraft 面板仍可访问")
			proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
			proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x30)
			return
		}
		systray.Quit()
	}()

	systray.Run(func() {
		systray.SetIcon(trayIcon)
		systray.SetTitle("BlockCraft")
		systray.SetTooltip("BlockCraft 世界管理面板")
		openItem := systray.AddMenuItem("打开面板", "在浏览器中打开 BlockCraft")
		restartItem := systray.AddMenuItem("仅重启面板", "重启面板进程，Minecraft 世界会继续运行")
		systray.AddSeparator()
		quitItem := systray.AddMenuItem("停止所有世界并退出", "安全停止所有 Minecraft 世界后关闭 BlockCraft")
		close(trayReady)
		go func() {
			for {
				select {
				case <-openItem.ClickedCh:
					if panelURL, ok := browserURL(dataDir); ok {
						openBrowser(panelURL)
					} else {
						showError("BlockCraft 面板暂时无法连接。请稍候再试，或查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
					}
				case <-restartItem.ClickedCh:
					logLauncher(logFile, "托盘选择：仅重启面板")
					restartItem.Disable()
					quitItem.Disable()
					systray.SetTooltip("正在重启面板，Minecraft 世界会继续运行…")
					restartAfterExit.Store(true)
					go func() {
						if err := restartPanelOnly(dataDir); err != nil {
							restartAfterExit.Store(false)
							restartItem.Enable()
							quitItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("面板没有重启，Minecraft 世界仍在运行。\n\n" + err.Error())
							title, _ := syscall.UTF16PtrFromString("无法重启 BlockCraft 面板")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
							return
						}
					}()
				case <-quitItem.ClickedCh:
					logLauncher(logFile, "托盘选择：停止所有世界并退出")
					if !confirmStopWorldsAndExit() {
						logLauncher(logFile, "用户取消关闭")
						continue
					}
					logLauncher(logFile, "用户确认关闭")
					shutdownAfterWorldsRequested.Store(true)
					quitItem.Disable()
					restartItem.Disable()
					systray.SetTooltip("正在安全停止 Minecraft 世界…")
					go func() {
						worlds, err := activeWorldNames(dataDir)
						if err != nil {
							shutdownAfterWorldsRequested.Store(false)
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("无法读取正在运行的世界列表，BlockCraft 保持运行。\n\n" + err.Error())
							title, _ := syscall.UTF16PtrFromString("无法关闭 BlockCraft")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
							return
						}
						logLauncher(logFile, "关闭前发现 %d 个活动世界：%s", len(worlds), strings.Join(worlds, ", "))
						closeProgress, shown := showShutdownProgress(worlds)
						if !shown {
							shutdownAfterWorldsRequested.Store(false)
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("安全关闭进度窗口没有显示，因此没有开始关闭世界。请重试或重新启动 BlockCraft。")
							title, _ := syscall.UTF16PtrFromString("无法安全关闭 BlockCraft")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
							return
						}
						if err := stopWorldsAndClosePanel(dataDir); err != nil {
							logLauncher(logFile, "面板拒绝关闭请求：%v", err)
							shutdownAfterWorldsRequested.Store(false)
							closeProgress()
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("世界尚未全部停止，BlockCraft 仍保持运行。\n\n请等待世界完成保存后再重试。\n" + err.Error())
							title, _ := syscall.UTF16PtrFromString("无法关闭 BlockCraft")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
							return
						}
						logLauncher(logFile, "面板已确认世界及 FRP 通道停止，等待面板进程退出")
						var exitErr error
						if adoptedPanel {
							select {
							case <-serverStopped:
							case <-time.After(10 * time.Second):
								exitErr = fmt.Errorf("同目录面板服务在 10 秒内没有退出")
							}
						} else {
							exitErr = waitForPanelExit(serverStopped, cmd.Process, 5*time.Second)
						}
						if exitErr != nil {
							logLauncher(logFile, "等待面板服务退出失败：%v", exitErr)
							shutdownAfterWorldsRequested.Store(false)
							closeProgress()
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("世界已安全停止，但 BlockCraft 面板服务仍未退出。请查看 data\\logs\\launcher.log。\n\n" + err.Error())
							title, _ := syscall.UTF16PtrFromString("BlockCraft 面板未退出")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
							return
						}
						logLauncher(logFile, "已确认面板进程退出")
						if !waitForPanelUnavailable(dataDir, 3*time.Second) {
							logLauncher(logFile, "面板端口仍有服务响应，保持托盘运行")
							shutdownAfterWorldsRequested.Store(false)
							closeProgress()
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("世界已经安全停止，但 127.0.0.1 面板地址仍有进程响应，不能确认面板已关闭。托盘保持运行，请检查该端口对应的进程后重试。")
							title, _ := syscall.UTF16PtrFromString("面板服务仍未关闭")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x30)
							return
						}
						logLauncher(logFile, "确认面板监听端口已关闭")
						openFrpPorts := waitForFrpAdminPortsClosed(dataDir, 3*time.Second)
						if len(openFrpPorts) > 0 {
							logLauncher(logFile, "FRP 管理端口仍在监听：%v；保持托盘运行", openFrpPorts)
							shutdownAfterWorldsRequested.Store(false)
							closeProgress()
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 仍有 FRP 进程运行")
							message, _ := syscall.UTF16PtrFromString(fmt.Sprintf("面板已退出，但 FRP 管理端口仍在监听：%v。托盘保持运行，请勿直接清理进程；检查端口对应的 frpc 后再重试。", openFrpPorts))
							title, _ := syscall.UTF16PtrFromString("FRP 通道仍未关闭")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x30)
							return
						}
						logLauncher(logFile, "面板端口和两个 FRP 管理端口均已关闭，退出托盘")
						closeProgress()
						systray.Quit()
					}()
				}
			}
		}()
	}, func() {})
	serverExitErr := <-serverExited
	if restartAfterExit.Load() {
		restart := exec.Command(executable)
		restart.Dir = releaseDir
		restart.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		if err := restart.Start(); err != nil {
			showError("面板已退出，但重新启动失败。请再次双击 BlockCraft.exe。")
			return 1
		}
		_ = restart.Process.Release()
		return 0
	}
	if serverExitErr != nil && !shutdownAfterWorldsRequested.Load() {
		showError("BlockCraft 服务意外退出。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
