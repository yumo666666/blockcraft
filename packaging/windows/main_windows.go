package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

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

func setDefaultEnv(key, value string) {
	if _, exists := os.LookupEnv(key); !exists {
		_ = os.Setenv(key, value)
	}
}

func readPanelConfig(file string) panelFile {
	var config panelFile
	data, err := os.ReadFile(file)
	if err == nil {
		_ = json.Unmarshal(data, &config)
	}
	return config
}

func browserURL(dataDir string) (string, bool) {
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
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	if config.Panel.Token != "" {
		url += "?token=" + config.Panel.Token
	}
	return url, true
}

func openBrowser(url string) {
	if url == "" {
		return
	}
	_ = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
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
	userDir := filepath.Join(localAppData, "BlockCraft")
	dataDir := filepath.Join(userDir, "data")
	instanceDir := filepath.Join(userDir, "instances")
	_ = os.MkdirAll(filepath.Join(dataDir, "logs"), 0o755)
	_ = os.MkdirAll(instanceDir, 0o755)
	setDefaultEnv("BC_ROOT", appDir)
	setDefaultEnv("BC_DATA_DIR", dataDir)
	setDefaultEnv("BC_INSTANCE_DIR", instanceDir)
	if url, ok := browserURL(dataDir); ok {
		openBrowser(url)
		return 0
	}

	logFile, err := os.OpenFile(filepath.Join(dataDir, "logs", "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		showError("无法创建日志文件。请检查用户目录是否可写。")
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
		showError("BlockCraft 服务没有启动。请查看 %LOCALAPPDATA%\\BlockCraft\\data\\logs\\launcher.log。")
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
				showError("BlockCraft 服务意外退出。请查看 %LOCALAPPDATA%\\BlockCraft\\data\\logs\\launcher.log。")
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
		showError("等待面板启动超时。请检查 %LOCALAPPDATA%\\BlockCraft\\data\\logs\\launcher.log。")
		return 1
	}

	if err := <-wait; err != nil {
		_, _ = fmt.Fprintln(logFile, "BlockCraft 服务退出:", strings.TrimSpace(err.Error()))
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
