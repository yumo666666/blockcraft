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
	return trayPanelPost(port, token, "/api/panel/shutdown-after-worlds", 24*time.Hour)
}

func activeWorldNames(dataDir string) ([]string, error) {
	port, token := panelConnection(dataDir)
	if token == "" {
		return nil, fmt.Errorf("没有找到面板令牌，无法确认正在运行的世界")
	}
	var response struct {
		Worlds []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"worlds"`
		Jobs []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Progress int    `json:"progress"`
		} `json:"jobs"`
		PendingSetups int `json:"pendingSetups"`
	}
	if err := trayPanelGetJSON(port, token, "/api/panel/shutdown-status", 15*time.Second, &response); err != nil {
		return nil, err
	}
	worlds := make([]string, 0, len(response.Worlds)+len(response.Jobs)+4)
	for _, world := range response.Worlds {
		switch world.Status {
		case "running", "starting", "stopping", "stuck":
			status := map[string]string{
				"running":  "运行中",
				"starting": "启动中",
				"stopping": "关闭中",
				"stuck":    "进程异常",
			}[world.Status]
			worlds = append(worlds, fmt.Sprintf("%s（%s）", world.Name, status))
		}
	}
	for _, job := range response.Jobs {
		worlds = append(worlds, fmt.Sprintf("正在创建/安装：%s（%d%%）", job.Title, job.Progress))
	}
	if response.PendingSetups > 0 {
		worlds = append(worlds, fmt.Sprintf("正在提交创建/导入请求：%d 项", response.PendingSetups))
	}
	return append(worlds, "世界 FRP 通道", "面板 FRP 通道", "面板服务", "BlockCraft 启动器（最后退出）"), nil
}

func appendClosedStatuses(items []string) []string {
	closed := make([]string, 0, len(items))
	for _, item := range items {
		if item == "BlockCraft 启动器（最后退出）" {
			closed = append(closed, "BlockCraft 启动器（所有项目关闭后最后退出）")
		} else {
			closed = append(closed, item+"（已关闭）")
		}
	}
	return closed
}

func appendShutdownStatuses(items []string) []string {
	statuses := make([]string, 0, len(items))
	for _, item := range items {
		switch item {
		case "面板服务":
			statuses = append(statuses, "面板服务（正在退出）")
		case "BlockCraft 启动器（最后退出）":
			statuses = append(statuses, "BlockCraft 启动器（等待其他项目关闭后最后退出）")
		default:
			statuses = append(statuses, item+"（已关闭）")
		}
	}
	return statuses
}

func restartPanelOnly(dataDir string) error {
	port, token := panelConnection(dataDir)
	if token == "" {
		return fmt.Errorf("没有找到面板令牌，无法安全重启面板")
	}
	return trayPanelPost(port, token, "/api/panel/shutdown", 10*time.Second)
}

// After the panel confirms that worlds and FRP stopped safely, wait for its
// process to exit. Never kill it on timeout: the close window stays visible
// until the process itself and its listening ports are gone.
func waitForPanelExit(exited <-chan struct{}, timeout time.Duration) error {
	select {
	case <-exited:
		return nil
	case <-time.After(timeout):
	}
	return fmt.Errorf("面板服务在 %s 内仍未退出", timeout)
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
						initialItems := []string{"正在运行或正在创建/导入的世界", "世界 FRP 通道", "面板 FRP 通道", "面板服务", "BlockCraft 启动器（最后退出）"}
						updateProgress, closeProgress, shown, windowErr := showShutdownProgress(initialItems)
						if !shown {
							logLauncher(logFile, "无法显示安全关闭进度窗口；没有开始关闭流程：%v", windowErr)
							shutdownAfterWorldsRequested.Store(false)
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							showError("无法显示安全关闭进度窗口，因此没有关闭世界、FRP 或面板。请检查系统桌面后重试。\n\n" + windowErr.Error())
							return
						}
						shutdownAccepted := false
						requestInFlight := false
						retryAt := time.Now()
						requestResult := make(chan error, 1)
						poll := time.NewTicker(2 * time.Second)
						defer poll.Stop()
						currentItems := initialItems
						seenItems := make(map[string]bool)
						allItems := make([]string, 0)
						rememberItems := func(items []string) {
							for _, item := range items {
								if !seenItems[item] {
									seenItems[item] = true
									allItems = append(allItems, item)
								}
							}
						}
						for {
							if shutdownAccepted {
								select {
								case <-serverStopped:
									logLauncher(logFile, "已确认面板进程退出")
									closedItems := appendClosedStatuses(allItems)
									updateProgress("确认面板监听端口已关闭", closedItems, "")
									for !waitForPanelUnavailable(dataDir, 3*time.Second) {
										updateProgress("等待 127.0.0.1 面板服务完全停止", closedItems, "面板端口仍有服务响应")
										time.Sleep(3 * time.Second)
									}
									for {
										openFrpPorts := waitForFrpAdminPortsClosed(dataDir, 3*time.Second)
										if len(openFrpPorts) == 0 {
											break
										}
										logLauncher(logFile, "FRP 管理端口仍在监听：%v；保持关闭弹窗等待", openFrpPorts)
										updateProgress("等待世界 FRP 和面板 FRP 完全停止", closedItems, fmt.Sprintf("仍在监听的 FRP 管理端口：%v", openFrpPorts))
										time.Sleep(3 * time.Second)
									}
									logLauncher(logFile, "所有世界、创建任务、FRP 通道和面板服务均已关闭，退出托盘")
									updateProgress("所有项目已关闭，正在退出启动器", closedItems, "")
									closeProgress()
									systray.Quit()
									return
								default:
									updateProgress("世界和 FRP 通道已关闭，等待面板服务退出", currentItems, "")
									time.Sleep(1 * time.Second)
									continue
								}
							}
							if !requestInFlight && !time.Now().Before(retryAt) {
								items, err := activeWorldNames(dataDir)
								if err != nil {
									logLauncher(logFile, "读取关闭目标失败，将继续显示弹窗并重试：%v", err)
									updateProgress("正在检查世界、创建/导入任务和服务进程", currentItems, err.Error())
									retryAt = time.Now().Add(3 * time.Second)
								} else {
									currentItems = items
									rememberItems(items)
									logLauncher(logFile, "关闭前待处理项目：%s", strings.Join(items, ", "))
									updateProgress("准备安全停止世界并结束创建/导入任务", items, "")
									logLauncher(logFile, "正在向面板请求安全停止世界、FRP 通道并关闭面板")
									requestInFlight = true
									go func() { requestResult <- stopWorldsAndClosePanel(dataDir) }()
								}
							}
							select {
							case err := <-requestResult:
								requestInFlight = false
								if err != nil {
									logLauncher(logFile, "关闭流程未完成；保持弹窗并自动重试：%v", err)
									updateProgress("等待世界、FRP 通道和面板安全关闭", currentItems, err.Error())
									retryAt = time.Now().Add(5 * time.Second)
								} else {
									shutdownAccepted = true
									logLauncher(logFile, "面板已确认世界和 FRP 通道停止，等待面板进程退出")
									currentItems = appendShutdownStatuses(allItems)
									updateProgress("世界和两个 FRP 通道已关闭，正在关闭面板服务", currentItems, "")
								}
							case <-poll.C:
								items, err := activeWorldNames(dataDir)
								if err != nil {
									updateProgress("正在关闭世界、FRP 通道和面板", currentItems, "正在刷新状态："+err.Error())
									continue
								}
								currentItems = items
								rememberItems(items)
								stage := "检查待关闭项目"
								if requestInFlight {
									stage = "正在安全停止世界并等待创建/导入任务结束"
								}
								updateProgress(stage, items, "")
							}
						}
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
