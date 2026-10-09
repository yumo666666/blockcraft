//go:build windows

package main

import (
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	wsCaption         = 0x00C00000
	wsBorder          = 0x00800000
	wsChild           = 0x40000000
	wsVisible         = 0x10000000
	wsVScroll         = 0x00200000
	esMultiline       = 0x0004
	esReadOnly        = 0x0800
	esAutoVScroll     = 0x0040
	ssLeft            = 0x0000
	wsExTopmost       = 0x00000008
	wmClose           = 0x0010
	wmDestroy         = 0x0002
	wmApp             = 0x8000
	shutdownDialogEnd = wmApp + 31
	wmSetFont         = 0x0030
	colorBtnFace      = 15
	smCxScreen        = 0
	smCyScreen        = 1
	swShow            = 5
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

var (
	shutdownUser32          = syscall.NewLazyDLL("user32.dll")
	shutdownKernel32        = syscall.NewLazyDLL("kernel32.dll")
	registerClassExW        = shutdownUser32.NewProc("RegisterClassExW")
	createWindowExW         = shutdownUser32.NewProc("CreateWindowExW")
	showWindow              = shutdownUser32.NewProc("ShowWindow")
	updateWindow            = shutdownUser32.NewProc("UpdateWindow")
	setForegroundWindow     = shutdownUser32.NewProc("SetForegroundWindow")
	getMessageW             = shutdownUser32.NewProc("GetMessageW")
	translateMessage        = shutdownUser32.NewProc("TranslateMessage")
	dispatchMessageW        = shutdownUser32.NewProc("DispatchMessageW")
	postMessageW            = shutdownUser32.NewProc("PostMessageW")
	destroyWindow           = shutdownUser32.NewProc("DestroyWindow")
	defWindowProcW          = shutdownUser32.NewProc("DefWindowProcW")
	postQuitMessage         = shutdownUser32.NewProc("PostQuitMessage")
	loadCursorW             = shutdownUser32.NewProc("LoadCursorW")
	getStockObject          = shutdownUser32.NewProc("GetStockObject")
	sendMessageW            = shutdownUser32.NewProc("SendMessageW")
	getSystemMetrics        = shutdownUser32.NewProc("GetSystemMetrics")
	getModuleHandleW        = shutdownKernel32.NewProc("GetModuleHandleW")
	shutdownWindowClassName = syscall.StringToUTF16Ptr("BlockCraftWorldShutdownProgress")
	shutdownWindowProc      = syscall.NewCallback(shutdownWindowProcedure)
)

func shutdownWindowProcedure(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmClose:
		// Deliberately do not close: the user should wait for safe world shutdown.
		return 0
	case shutdownDialogEnd:
		destroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
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
		background: colorBtnFace + 1,
		className:  shutdownWindowClassName,
	}
	atom, _, _ := registerClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom != 0 {
		return true
	}
	// ERROR_CLASS_ALREADY_EXISTS is expected if a previous close operation opened it.
	return syscall.GetLastError() == syscall.Errno(1410)
}

func shutdownProgressText(worlds []string) string {
	var text strings.Builder
	if len(worlds) > 0 {
		text.WriteString("正在安全关闭以下世界：\r\n\r\n")
	} else {
		text.WriteString("正在确认所有世界均已停止：\r\n\r\n")
	}
	for _, world := range worlds {
		text.WriteString("  • ")
		text.WriteString(world)
		text.WriteString("\r\n")
	}
	text.WriteString("\r\n请耐心等待世界完成保存并关闭。\r\n之后会依次关闭世界与面板 FRP 通道、面板服务和托盘启动器。\r\n请勿手动结束进程，以免世界存档损坏。")
	return text.String()
}

// showShutdownProgress displays a topmost, non-dismissible native window while
// the tray waits for the panel to finish stopping every world.
func showShutdownProgress(worlds []string) (func(), bool) {
	ready := make(chan uintptr, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if !shutdownWindowReady() {
			ready <- 0
			return
		}

		const width, minHeight, rowHeight = 580, 215, 24
		height := minHeight + rowHeight*len(worlds)
		if height > 650 {
			height = 650
		}
		screenWidth, _, _ := getSystemMetrics.Call(smCxScreen)
		screenHeight, _, _ := getSystemMetrics.Call(smCyScreen)
		x := int32((int(screenWidth) - width) / 2)
		y := int32((int(screenHeight) - height) / 2)
		title := syscall.StringToUTF16Ptr("正在安全关闭 BlockCraft")
		text := syscall.StringToUTF16Ptr(shutdownProgressText(worlds))
		instance, _, _ := getModuleHandleW.Call(0)
		// No WS_SYSMENU means Windows does not draw a close button. WM_CLOSE is
		// also ignored above so Alt+F4 cannot interrupt the save and shutdown.
		hwnd, _, _ := createWindowExW.Call(
			wsExTopmost,
			uintptr(unsafe.Pointer(shutdownWindowClassName)),
			uintptr(unsafe.Pointer(title)),
			wsCaption|wsBorder,
			uintptr(x), uintptr(y), uintptr(width), uintptr(height),
			0, 0, instance, 0,
		)
		if hwnd == 0 {
			ready <- 0
			return
		}
		controlClass := syscall.StringToUTF16Ptr("EDIT")
		edit, _, _ := createWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(controlClass)),
			uintptr(unsafe.Pointer(text)),
			wsChild|wsVisible|wsVScroll|esMultiline|esReadOnly|esAutoVScroll,
			18, 18, uintptr(width-36), uintptr(height-36),
			hwnd, 0, instance, 0,
		)
		font, _, _ := getStockObject.Call(17) // DEFAULT_GUI_FONT
		sendMessageW.Call(edit, wmSetFont, font, 1)
		showWindow.Call(hwnd, swShow)
		updateWindow.Call(hwnd)
		setForegroundWindow.Call(hwnd)
		ready <- hwnd

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

	hwnd := <-ready
	if hwnd == 0 {
		return func() {}, false
	}
	return func() {
		postMessageW.Call(hwnd, shutdownDialogEnd, 0, 0)
	}, true
}
