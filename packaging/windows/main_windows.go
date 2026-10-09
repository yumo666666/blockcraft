package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
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
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/api/panel/shutdown-after-worlds?%s", port, neturl.Values{"token": {token}}.Encode())
	request, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("x-blockcraft", "1")
	client := &http.Client{Timeout: 10 * time.Minute, Transport: &http.Transport{Proxy: nil}}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("连接面板失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error.Message != "" {
		return fmt.Errorf("%s", payload.Error.Message)
	}
	return fmt.Errorf("面板返回 HTTP %d", response.StatusCode)
}

func restartPanelOnly(dataDir string) error {
	port, token := panelConnection(dataDir)
	if token == "" {
		return fmt.Errorf("没有找到面板令牌，无法安全重启面板")
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/api/panel/shutdown?%s", port, neturl.Values{"token": {token}}.Encode())
	request, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("x-blockcraft", "1")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("连接面板失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error.Message != "" {
		return fmt.Errorf("%s", payload.Error.Message)
	}
	return fmt.Errorf("面板返回 HTTP %d", response.StatusCode)
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
	_ = os.Setenv("BC_ROOT", appDir)
	_ = os.Setenv("BC_DATA_DIR", dataDir)
	_ = os.Setenv("BC_INSTANCE_DIR", instanceDir)
	if url, ok := browserURL(dataDir); ok {
		openBrowser(url)
		return 0
	}

	logFile, err := os.OpenFile(filepath.Join(dataDir, "logs", "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		showError("无法在 BlockCraft 文件夹内创建日志。请检查文件夹是否可写，并避免放在只读目录。")
		return 1
	}
	defer logFile.Close()

	cmd := exec.Command(nodeExe, "--experimental-strip-types", "--use-env-proxy", entry)
	cmd.Dir = appDir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		_, _ = fmt.Fprintln(logFile, "启动 Node.js 失败:", err)
		showError("BlockCraft 服务没有启动。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
		return 1
	}

	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	deadline := time.Now().Add(90 * time.Second)
	opened := false
	for time.Now().Before(deadline) {
		select {
		case err := <-wait:
			if err != nil {
				_, _ = fmt.Fprintln(logFile, "BlockCraft 服务退出:", err)
				showError("BlockCraft 服务意外退出。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
				return 1
			}
			return 0
		default:
		}
		if url, ok := browserURL(dataDir); ok {
			openBrowser(url)
			opened = true
			break
		}
		time.Sleep(time.Second)
	}
	if !opened {
		_ = cmd.Process.Kill()
		_, _ = fmt.Fprintln(logFile, "等待面板启动超时")
		showError("等待面板启动超时。请检查 BlockCraft 文件夹内 data\\logs\\launcher.log。")
		return 1
	}

	serverExited := make(chan error, 1)
	trayReady := make(chan struct{})
	var restartAfterExit atomic.Bool
	go func() {
		err := <-wait
		if err != nil {
			_, _ = fmt.Fprintln(logFile, "BlockCraft 服务退出:", strings.TrimSpace(err.Error()))
		}
		serverExited <- err
		<-trayReady
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
					if !confirmStopWorldsAndExit() {
						continue
					}
					quitItem.Disable()
					restartItem.Disable()
					systray.SetTooltip("正在安全停止 Minecraft 世界…")
					go func() {
						if err := stopWorldsAndClosePanel(dataDir); err != nil {
							quitItem.Enable()
							restartItem.Enable()
							systray.SetTooltip("BlockCraft 世界管理面板")
							message, _ := syscall.UTF16PtrFromString("世界尚未全部停止，BlockCraft 仍保持运行。\n\n" + err.Error())
							title, _ := syscall.UTF16PtrFromString("无法关闭 BlockCraft")
							proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
							proc.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
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
	if serverExitErr != nil {
		showError("BlockCraft 服务意外退出。请查看 BlockCraft 文件夹内 data\\logs\\launcher.log。")
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
