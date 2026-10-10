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
	wsChild           = 0x40000000
	wsVisible         = 0x10000000
	wsVScroll         = 0x00200000
	esMultiline       = 0x0004
	esReadOnly        = 0x0800
	esAutoVScroll     = 0x0040
	wsExTopmost       = 0x00000008
	wmClose           = 0x0010
	wmDestroy         = 0x0002
	wmPaint           = 0x000F
	wmEraseBkgnd      = 0x0014
	wmCtlColorEdit    = 0x0133
	wmApp             = 0x8000
	shutdownDialogEnd = wmApp + 31
	wmSetFont         = 0x0030
	wmSetText         = 0x000C
	emSetMargins      = 0x00D3
	textSingleLine    = 0x0020
	textVCenter       = 0x0004
	bkOpaque          = 2
	fontWeightBold    = 700
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
	getMessageW             = shutdownUser32.NewProc("GetMessageW")
	translateMessage        = shutdownUser32.NewProc("TranslateMessage")
	dispatchMessageW        = shutdownUser32.NewProc("DispatchMessageW")
	postMessageW            = shutdownUser32.NewProc("PostMessageW")
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
	setBkColor              = shutdownGdi32.NewProc("SetBkColor")
	setBkMode               = shutdownGdi32.NewProc("SetBkMode")
	createFontW             = shutdownGdi32.NewProc("CreateFontW")
	selectObject            = shutdownGdi32.NewProc("SelectObject")
	sendMessageW            = shutdownUser32.NewProc("SendMessageW")
	getSystemMetrics        = shutdownUser32.NewProc("GetSystemMetrics")
	getModuleHandleW        = shutdownKernel32.NewProc("GetModuleHandleW")
	shutdownWindowClassName = syscall.StringToUTF16Ptr("BlockCraftWorldShutdownProgress")
	shutdownWindowProc      = syscall.NewCallback(shutdownWindowProcedure)
	shutdownEditBrush       atomic.Uintptr
)

func shutdownRGB(r, g, b byte) uintptr {
	return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16
}

func drawShutdownText(hdc uintptr, value string, rect shutdownRect, color uintptr, flags uintptr) {
	text := syscall.StringToUTF16(value)
	length := int32(-1)
	setTextColor.Call(hdc, color)
	setBkMode.Call(hdc, bkOpaque)
	drawTextW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(length), uintptr(unsafe.Pointer(&rect)), flags)
	runtime.KeepAlive(text)
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
	panel, _, _ := createSolidBrush.Call(shutdownRGB(29, 39, 33))
	border, _, _ := createSolidBrush.Call(shutdownRGB(49, 66, 55))
	accent, _, _ := createSolidBrush.Call(shutdownRGB(132, 200, 95))
	if background != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), background)
	}
	if accent != 0 {
		stripe := shutdownRect{left: 0, top: 0, right: client.right, bottom: 5}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&stripe)), accent)
	}
	if panel != 0 {
		header := shutdownRect{left: 1, top: 5, right: client.right - 1, bottom: 79}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&header)), panel)
		card := shutdownRect{left: 18, top: 88, right: client.right - 18, bottom: client.bottom - 49}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&card)), panel)
	}
	if border != 0 {
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&client)), border)
		separator := shutdownRect{left: 1, top: 78, right: client.right - 1, bottom: 79}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&separator)), border)
		card := shutdownRect{left: 18, top: 88, right: client.right - 18, bottom: client.bottom - 49}
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&card)), border)
	}
	face := syscall.StringToUTF16("Segoe UI")
	fontHeight := int32(-22)
	font, _, _ := createFontW.Call(
		uintptr(fontHeight), 0, 0, 0, fontWeightBold, 0, 0, 0,
		1, 0, 0, 5, 0, uintptr(unsafe.Pointer(&face[0])),
	)
	oldFont := uintptr(0)
	if font != 0 {
		oldFont, _, _ = selectObject.Call(hdc, font)
	}
	title := shutdownRect{left: 25, top: 19, right: client.right - 24, bottom: 51}
	drawShutdownText(hdc, "正在安全关闭 BlockCraft", title, shutdownRGB(229, 237, 231), textSingleLine|textVCenter)
	if font != 0 {
		selectObject.Call(hdc, oldFont)
		deleteObject.Call(font)
	}
	runtime.KeepAlive(face)
	subtitle := shutdownRect{left: 26, top: 50, right: client.right - 24, bottom: 73}
	drawShutdownText(hdc, "等待世界、FRP 与面板服务全部停止后，启动器才会退出", subtitle, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	footer := shutdownRect{left: 26, top: client.bottom - 38, right: client.right - 24, bottom: client.bottom - 14}
	drawShutdownText(hdc, "请耐心等待 · 请勿手动结束进程，以免世界存档损坏", footer, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	for _, brush := range []uintptr{background, panel, border, accent} {
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
	case wmCtlColorEdit:
		setTextColor.Call(wParam, shutdownRGB(221, 231, 224))
		setBkColor.Call(wParam, shutdownRGB(29, 39, 33))
		setBkMode.Call(wParam, bkOpaque)
		return shutdownEditBrush.Load()
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
	var editHandle atomic.Uintptr
	var textMu sync.Mutex
	currentText := shutdownProgressText("正在检查世界与创建/导入任务", items, "")
	update := func(stage string, nextItems []string, detail string) {
		text := shutdownProgressText(stage, nextItems, detail)
		textMu.Lock()
		currentText = text
		edit := editHandle.Load()
		textMu.Unlock()
		if edit != 0 {
			utf16 := syscall.StringToUTF16(text)
			sendMessageW.Call(edit, wmSetText, 0, uintptr(unsafe.Pointer(&utf16[0])))
			runtime.KeepAlive(utf16)
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

		const width, minHeight, rowHeight = 700, 390, 26
		height := minHeight + rowHeight*len(items)
		if height > 690 {
			height = 690
		}
		screenWidth, _, _ := getSystemMetrics.Call(smCxScreen)
		screenHeight, _, _ := getSystemMetrics.Call(smCyScreen)
		x := int32((int(screenWidth) - width) / 2)
		y := int32((int(screenHeight) - height) / 2)
		textMu.Lock()
		text := syscall.StringToUTF16Ptr(currentText)
		textMu.Unlock()
		instance, _, _ := getModuleHandleW.Call(0)
		// A custom frameless window matches the panel's dark green theme and
		// deliberately has no close button.
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
		brush, _, _ := createSolidBrush.Call(shutdownRGB(29, 39, 33))
		if brush == 0 {
			destroyWindow.Call(hwnd)
			hwnd = 0
			failStartup(fmt.Errorf("创建进度窗背景失败：%v", syscall.GetLastError()))
			return
		}
		shutdownEditBrush.Store(brush)
		controlClass := syscall.StringToUTF16Ptr("EDIT")
		edit, _, _ := createWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(controlClass)),
			uintptr(unsafe.Pointer(text)),
			wsChild|wsVisible|wsVScroll|esMultiline|esReadOnly|esAutoVScroll,
			24, 94, uintptr(width-48), uintptr(height-151),
			hwnd, 0, instance, 0,
		)
		if edit == 0 {
			deleteObject.Call(brush)
			shutdownEditBrush.Store(0)
			destroyWindow.Call(hwnd)
			hwnd = 0
			failStartup(fmt.Errorf("创建关闭进度文本框失败：%v", syscall.GetLastError()))
			return
		}
		if edit == 0 {
			destroyWindow.Call(hwnd)
			hwnd = 0
			failStartup(fmt.Errorf("创建关闭进度文本框失败：%v", syscall.GetLastError()))
			return
		}
		textMu.Lock()
		editHandle.Store(edit)
		latestText := syscall.StringToUTF16Ptr(currentText)
		textMu.Unlock()
		sendMessageW.Call(edit, wmSetText, 0, uintptr(unsafe.Pointer(latestText)))
		font, _, _ := getStockObject.Call(17) // DEFAULT_GUI_FONT
		if font == 0 {
			deleteObject.Call(brush)
			shutdownEditBrush.Store(0)
			destroyWindow.Call(hwnd)
			hwnd = 0
			failStartup(fmt.Errorf("读取 Windows 默认字体失败：%v", syscall.GetLastError()))
			return
		}
		sendMessageW.Call(edit, wmSetFont, font, 1)
		sendMessageW.Call(edit, emSetMargins, 0, uintptr(12)|(uintptr(12)<<16))
		select {
		case <-cancel:
			destroyWindow.Call(hwnd)
			deleteObject.Call(brush)
			shutdownEditBrush.Store(0)
			hwnd = 0
			signalReady(0)
			return
		default:
		}
		showWindow.Call(hwnd, swShow)
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
		deleteObject.Call(brush)
		shutdownEditBrush.Store(0)
	}()
	var hwnd uintptr
	select {
	case hwnd = <-ready:
		if hwnd == 0 {
			select {
			case err := <-startupFailure:
				return update, func() {}, false, err
			default:
				return update, func() {}, false, fmt.Errorf("关闭进度窗没有返回有效窗口句柄")
			}
		}
	case <-time.After(10 * time.Second):
		close(cancel)
		return update, func() {}, false, fmt.Errorf("等待关闭进度窗显示超过 10 秒")
	}

	closeProgress := func() {
		closeOnce.Do(func() {
			close(cancel)
			postMessageW.Call(hwnd, shutdownDialogEnd, 0, 0)
		})
	}
	return update, closeProgress, true, nil
}
