//go:build windows

package main

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	wsPopup           = 0x80000000
	wsExTopmost       = 0x00000008
	wmClose           = 0x0010
	wmDestroy         = 0x0002
	wmPaint           = 0x000F
	wmEraseBkgnd      = 0x0014
	wmTimer           = 0x0113
	wmApp             = 0x8000
	shutdownDialogEnd = wmApp + 31

	textSingleLine = 0x0020
	textVCenter    = 0x0004
	textWordBreak  = 0x0010
	textNoPrefix   = 0x0800
	bkTransparent  = 1
	fontWeight     = 400
	fontWeightBold = 700

	smCxScreen = 0
	smCyScreen = 1
	swShow     = 5

	swpNoSize            = 0x0001
	swpNoMove            = 0x0002
	swpNoActivate        = 0x0010
	swpShowWindow        = 0x0040
	shutdownTopmostTimer = 1
)

type shutdownPoint struct {
	x int32
	y int32
}

type shutdownMessage struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	point   shutdownPoint
	private uint32
}

type shutdownWindowClass struct {
	size        uint32
	style       uint32
	windowProc  uintptr
	classExtra  int32
	windowExtra int32
	instance    uintptr
	icon        uintptr
	cursor      uintptr
	background  uintptr
	menuName    *uint16
	className   *uint16
	iconSmall   uintptr
}

type shutdownRect struct {
	left, top, right, bottom int32
}

type shutdownPaintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     shutdownRect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

var (
	shutdownUser32          = syscall.NewLazyDLL("user32.dll")
	shutdownKernel32        = syscall.NewLazyDLL("kernel32.dll")
	shutdownGdi32           = syscall.NewLazyDLL("gdi32.dll")
	registerClassExW        = shutdownUser32.NewProc("RegisterClassExW")
	createWindowExW         = shutdownUser32.NewProc("CreateWindowExW")
	showWindow              = shutdownUser32.NewProc("ShowWindow")
	updateWindow            = shutdownUser32.NewProc("UpdateWindow")
	setForegroundWindow     = shutdownUser32.NewProc("SetForegroundWindow")
	setWindowPos            = shutdownUser32.NewProc("SetWindowPos")
	setTimer                = shutdownUser32.NewProc("SetTimer")
	killTimer               = shutdownUser32.NewProc("KillTimer")
	getMessageW             = shutdownUser32.NewProc("GetMessageW")
	translateMessage        = shutdownUser32.NewProc("TranslateMessage")
	dispatchMessageW        = shutdownUser32.NewProc("DispatchMessageW")
	postMessageW            = shutdownUser32.NewProc("PostMessageW")
	invalidateRect          = shutdownUser32.NewProc("InvalidateRect")
	destroyWindow           = shutdownUser32.NewProc("DestroyWindow")
	defWindowProcW          = shutdownUser32.NewProc("DefWindowProcW")
	postQuitMessage         = shutdownUser32.NewProc("PostQuitMessage")
	loadCursorW             = shutdownUser32.NewProc("LoadCursorW")
	beginPaint              = shutdownUser32.NewProc("BeginPaint")
	endPaint                = shutdownUser32.NewProc("EndPaint")
	getClientRect           = shutdownUser32.NewProc("GetClientRect")
	fillRect                = shutdownUser32.NewProc("FillRect")
	frameRect               = shutdownUser32.NewProc("FrameRect")
	drawTextW               = shutdownUser32.NewProc("DrawTextW")
	getStockObject          = shutdownGdi32.NewProc("GetStockObject")
	createSolidBrush        = shutdownGdi32.NewProc("CreateSolidBrush")
	deleteObject            = shutdownGdi32.NewProc("DeleteObject")
	setTextColor            = shutdownGdi32.NewProc("SetTextColor")
	setBkMode               = shutdownGdi32.NewProc("SetBkMode")
	createFontW             = shutdownGdi32.NewProc("CreateFontW")
	selectObject            = shutdownGdi32.NewProc("SelectObject")
	getSystemMetrics        = shutdownUser32.NewProc("GetSystemMetrics")
	getModuleHandleW        = shutdownKernel32.NewProc("GetModuleHandleW")
	shutdownWindowClassName = syscall.StringToUTF16Ptr("BlockCraftWorldShutdownProgress")
	shutdownWindowProc      = syscall.NewCallback(shutdownWindowProcedure)
	shutdownWindowHandle    atomic.Uintptr
	shutdownCurrentText     atomic.Pointer[string]
)

func shutdownRGB(r, g, b byte) uintptr {
	return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16
}

func drawShutdownText(hdc uintptr, value string, rect shutdownRect, color uintptr, flags uintptr) {
	text := syscall.StringToUTF16(value)
	if len(text) == 0 {
		return
	}
	setTextColor.Call(hdc, color)
	setBkMode.Call(hdc, bkTransparent)
	drawTextW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(uint32(len(text)-1)), uintptr(unsafe.Pointer(&rect)), flags|textNoPrefix)
	runtime.KeepAlive(text)
}

func selectedShutdownFont(hdc uintptr, height int32, weight uintptr) (uintptr, uintptr) {
	face := syscall.StringToUTF16("Segoe UI")
	font, _, _ := createFontW.Call(
		uintptr(uint32(height)), 0, 0, 0, weight, 0, 0, 0,
		1, 0, 0, 5, 0, uintptr(unsafe.Pointer(&face[0])),
	)
	oldFont := uintptr(0)
	if font != 0 {
		oldFont, _, _ = selectObject.Call(hdc, font)
	}
	runtime.KeepAlive(face)
	return font, oldFont
}

func restoreShutdownFont(hdc uintptr, font, oldFont uintptr) {
	if font == 0 {
		return
	}
	selectObject.Call(hdc, oldFont)
	deleteObject.Call(font)
}

func currentShutdownText() string {
	value := shutdownCurrentText.Load()
	if value == nil {
		return ""
	}
	return *value
}

func paintShutdownWindow(hwnd uintptr) uintptr {
	var paint shutdownPaintStruct
	hdc, _, _ := beginPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return 0
	}
	var client shutdownRect
	getClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	background, _, _ := createSolidBrush.Call(shutdownRGB(17, 23, 19))
	headerBrush, _, _ := createSolidBrush.Call(shutdownRGB(29, 39, 33))
	cardBrush, _, _ := createSolidBrush.Call(shutdownRGB(23, 32, 27))
	border, _, _ := createSolidBrush.Call(shutdownRGB(49, 66, 55))
	accent, _, _ := createSolidBrush.Call(shutdownRGB(132, 200, 95))
	if background != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), background)
	}
	if accent != 0 {
		stripe := shutdownRect{left: 0, top: 0, right: client.right, bottom: 5}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&stripe)), accent)
	}
	if headerBrush != 0 {
		header := shutdownRect{left: 1, top: 5, right: client.right - 1, bottom: 89}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&header)), headerBrush)
	}
	card := shutdownRect{left: 20, top: 102, right: client.right - 20, bottom: client.bottom - 60}
	if cardBrush != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&card)), cardBrush)
	}
	if border != 0 {
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&client)), border)
		separator := shutdownRect{left: 1, top: 89, right: client.right - 1, bottom: 90}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&separator)), border)
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&card)), border)
	}

	titleFont, oldTitleFont := selectedShutdownFont(hdc, -22, fontWeightBold)
	title := shutdownRect{left: 28, top: 19, right: client.right - 28, bottom: 52}
	drawShutdownText(hdc, "正在安全关闭 BlockCraft", title, shutdownRGB(229, 237, 231), textSingleLine|textVCenter)
	restoreShutdownFont(hdc, titleFont, oldTitleFont)

	subtitleFont, oldSubtitleFont := selectedShutdownFont(hdc, -14, fontWeight)
	subtitle := shutdownRect{left: 29, top: 55, right: client.right - 28, bottom: 80}
	drawShutdownText(hdc, "等待世界、FRP 与面板服务全部停止后，启动器才会退出", subtitle, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	body := shutdownRect{left: 38, top: 116, right: client.right - 36, bottom: client.bottom - 70}
	drawShutdownText(hdc, currentShutdownText(), body, shutdownRGB(221, 231, 224), textWordBreak)

	footer := shutdownRect{left: 29, top: client.bottom - 47, right: client.right - 28, bottom: client.bottom - 19}
	drawShutdownText(hdc, "请耐心等待 · 请勿手动结束进程，以免世界存档损坏", footer, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	restoreShutdownFont(hdc, subtitleFont, oldSubtitleFont)

	for _, brush := range []uintptr{background, headerBrush, cardBrush, border, accent} {
		if brush != 0 {
			deleteObject.Call(brush)
		}
	}
	endPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	return 0
}

func shutdownWindowProcedure(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmPaint:
		return paintShutdownWindow(hwnd)
	case wmEraseBkgnd:
		return 1
	case wmTimer:
		// Keep the non-dismissible progress window above ordinary and other
		// topmost windows throughout a potentially long shutdown sequence.
		setWindowPos.Call(hwnd, ^uintptr(0), 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
		return 0
	case wmClose:
		// Deliberately do not close: the user should wait for safe world shutdown.
		return 0
	case shutdownDialogEnd:
		killTimer.Call(hwnd, shutdownTopmostTimer)
		destroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		shutdownWindowHandle.Store(0)
		postQuitMessage.Call(0)
		return 0
	default:
		result, _, _ := defWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return result
	}
}

func shutdownWindowReady() bool {
	instance, _, _ := getModuleHandleW.Call(0)
	cursor, _, _ := loadCursorW.Call(0, 32512) // IDC_ARROW
	class := shutdownWindowClass{
		size:       uint32(unsafe.Sizeof(shutdownWindowClass{})),
		windowProc: shutdownWindowProc,
		instance:   instance,
		cursor:     cursor,
		className:  shutdownWindowClassName,
	}
	atom, _, _ := registerClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom != 0 {
		return true
	}
	// ERROR_CLASS_ALREADY_EXISTS is expected if a previous close operation opened it.
	return syscall.GetLastError() == syscall.Errno(1410)
}

func shutdownProgressText(stage string, items []string, detail string) string {
	var text strings.Builder
	text.WriteString("当前步骤：")
	text.WriteString(stage)
	text.WriteString("\r\n\r\n待处理项目：\r\n")
	for _, world := range items {
		text.WriteString("  • ")
		text.WriteString(world)
		text.WriteString("\r\n")
	}
	if detail != "" {
		text.WriteString("\r\n正在等待并自动重试：\r\n")
		text.WriteString(detail)
		text.WriteString("\r\n")
	}
	return text.String()
}

// showShutdownProgress starts a topmost, non-dismissible native window while
// the tray waits for the panel to finish stopping every world. It reports
// whether the window was actually created so the caller can refuse to start
// shutdown if it cannot keep the progress visible.
func showShutdownProgress(items []string) (func(string, []string, string), func(), bool, error) {
	ready := make(chan uintptr, 1)
	startupFailure := make(chan error, 1)
	cancel := make(chan struct{})
	var closeOnce sync.Once
	initialText := shutdownProgressText("正在检查世界与创建/导入任务", items, "")
	shutdownCurrentText.Store(&initialText)
	update := func(stage string, nextItems []string, detail string) {
		text := shutdownProgressText(stage, nextItems, detail)
		shutdownCurrentText.Store(&text)
		if hwnd := shutdownWindowHandle.Load(); hwnd != 0 {
			invalidateRect.Call(hwnd, 0, 1)
		}
	}
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		var hwnd uintptr
		readySent := false
		signalReady := func(handle uintptr) {
			readySent = true
			ready <- handle
		}
		failStartup := func(err error) {
			startupFailure <- err
			signalReady(0)
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				// A missing or failing Win32 entry point must not crash the tray
				// process and orphan the panel/world child processes.
				if hwnd != 0 {
					func() {
						defer func() { _ = recover() }()
						destroyWindow.Call(hwnd)
					}()
				}
				if !readySent {
					select {
					case startupFailure <- fmt.Errorf("创建关闭进度窗时发生异常：%v", recovered):
					default:
					}
					signalReady(0)
				}
			}
		}()
		if !shutdownWindowReady() {
			failStartup(fmt.Errorf("注册关闭进度窗失败：%v", syscall.GetLastError()))
			return
		}

		const width, minHeight, rowHeight = 760, 420, 26
		height := minHeight + rowHeight*len(items)
		if height > 690 {
			height = 690
		}
		screenWidth, _, _ := getSystemMetrics.Call(smCxScreen)
		screenHeight, _, _ := getSystemMetrics.Call(smCyScreen)
		x := int32((int(screenWidth) - width) / 2)
		y := int32((int(screenHeight) - height) / 2)
		instance, _, _ := getModuleHandleW.Call(0)
		hwnd, _, _ = createWindowExW.Call(
			wsExTopmost,
			uintptr(unsafe.Pointer(shutdownWindowClassName)),
			0,
			wsPopup,
			uintptr(x), uintptr(y), uintptr(width), uintptr(height),
			0, 0, instance, 0,
		)
		if hwnd == 0 {
			failStartup(fmt.Errorf("创建关闭进度窗失败：%v", syscall.GetLastError()))
			return
		}
		shutdownWindowHandle.Store(hwnd)
		select {
		case <-cancel:
			destroyWindow.Call(hwnd)
			hwnd = 0
			signalReady(0)
			return
		default:
		}
		showWindow.Call(hwnd, swShow)
		setWindowPos.Call(hwnd, ^uintptr(0), 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
		setTimer.Call(hwnd, shutdownTopmostTimer, 1000, 0)
		updateWindow.Call(hwnd)
		setForegroundWindow.Call(hwnd)
		signalReady(hwnd)

		for {
			var message shutdownMessage
			result, _, _ := getMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
			if result == 0 || result == ^uintptr(0) {
				break
			}
			translateMessage.Call(uintptr(unsafe.Pointer(&message)))
			dispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
		}
	}()
	var hwnd uintptr
	select {
	case hwnd = <-ready:
		if hwnd == 0 {
			shutdownCurrentText.Store(nil)
			select {
			case err := <-startupFailure:
				return update, func() {}, false, err
			default:
				return update, func() {}, false, fmt.Errorf("关闭进度窗没有返回有效窗口句柄")
			}
		}
	case <-time.After(10 * time.Second):
		close(cancel)
		shutdownCurrentText.Store(nil)
		return update, func() {}, false, fmt.Errorf("等待关闭进度窗显示超过 10 秒")
	}

	closeProgress := func() {
		closeOnce.Do(func() {
			close(cancel)
			postMessageW.Call(hwnd, shutdownDialogEnd, 0, 0)
			shutdownCurrentText.Store(nil)
		})
	}
	return update, closeProgress, true, nil
}
