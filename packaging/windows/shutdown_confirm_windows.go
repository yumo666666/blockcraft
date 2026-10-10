//go:build windows

package main

import (
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"
)

const (
	wmLButtonUp = 0x0202
	wmKeyDown   = 0x0100
	wmSetCursor = 0x0020

	wsBorder      = 0x00800000
	vkReturn      = 0x0D
	vkEscape      = 0x1B
	vkY           = 0x59
	vkN           = 0x4E
	idYes         = 6
	idNo          = 7
	confirmWindowWidth  = 580
	confirmWindowHeight = 270
)

var (
	shutdownConfirmClassName = syscall.StringToUTF16Ptr("BlockCraftShutdownConfirmation")
	shutdownConfirmWindowProc = syscall.NewCallback(shutdownConfirmationWindowProcedure)
	shutdownConfirmResult atomic.Int32
)

func paintShutdownConfirmation(hwnd uintptr) uintptr {
	var paint shutdownPaintStruct
	hdc, _, _ := beginPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return 0
	}
	var client shutdownRect
	getClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	background, _, _ := createSolidBrush.Call(shutdownRGB(17, 23, 19))
	headerBrush, _, _ := createSolidBrush.Call(shutdownRGB(29, 39, 33))
	border, _, _ := createSolidBrush.Call(shutdownRGB(67, 91, 72))
	accent, _, _ := createSolidBrush.Call(shutdownRGB(132, 200, 95))
	button, _, _ := createSolidBrush.Call(shutdownRGB(132, 200, 95))
	buttonQuiet, _, _ := createSolidBrush.Call(shutdownRGB(29, 39, 33))
	if background != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), background)
	}
	stripe := shutdownRect{left: 0, top: 0, right: client.right, bottom: 5}
	if accent != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&stripe)), accent)
	}
	header := shutdownRect{left: 1, top: 5, right: client.right - 1, bottom: 56}
	if headerBrush != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&header)), headerBrush)
	}
	frame := shutdownRect{left: 0, top: 0, right: client.right, bottom: client.bottom}
	if border != 0 {
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&frame)), border)
		separator := shutdownRect{left: 1, top: 56, right: client.right - 1, bottom: 57}
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&separator)), border)
	}

	titleFont, oldTitleFont := selectedShutdownFont(hdc, -20, fontWeightBold)
	title := shutdownRect{left: 28, top: 15, right: client.right - 56, bottom: 48}
	drawShutdownText(hdc, "关闭 BlockCraft", title, shutdownRGB(229, 237, 231), textSingleLine|textVCenter)
	closeGlyph := shutdownRect{left: client.right - 42, top: 10, right: client.right - 14, bottom: 48}
	drawShutdownText(hdc, "×", closeGlyph, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	restoreShutdownFont(hdc, titleFont, oldTitleFont)

	bodyFont, oldBodyFont := selectedShutdownFont(hdc, -16, fontWeight)
	body1 := shutdownRect{left: 34, top: 78, right: client.right - 30, bottom: 112}
	body2 := shutdownRect{left: 34, top: 116, right: client.right - 30, bottom: 150}
	drawShutdownText(hdc, "这会先安全停止所有正在运行的 Minecraft 世界，然后关闭 BlockCraft。", body1, shutdownRGB(221, 231, 224), textSingleLine|textVCenter)
	drawShutdownText(hdc, "停止过程可能需要一些时间。是否继续？", body2, shutdownRGB(155, 171, 160), textSingleLine|textVCenter)
	restoreShutdownFont(hdc, bodyFont, oldBodyFont)

	// The lower-right pair mirrors BlockCraft's secondary and primary actions.
	noRect := shutdownRect{left: client.right - 248, top: client.bottom - 58, right: client.right - 142, bottom: client.bottom - 20}
	yesRect := shutdownRect{left: client.right - 130, top: client.bottom - 58, right: client.right - 24, bottom: client.bottom - 20}
	if buttonQuiet != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&noRect)), buttonQuiet)
	}
	if border != 0 {
		frameRect.Call(hdc, uintptr(unsafe.Pointer(&noRect)), border)
	}
	if button != 0 {
		fillRect.Call(hdc, uintptr(unsafe.Pointer(&yesRect)), button)
	}
	labelFont, oldLabelFont := selectedShutdownFont(hdc, -15, fontWeightBold)
	drawShutdownText(hdc, "否 (N)", noRect, shutdownRGB(221, 231, 224), textSingleLine|textVCenter)
	drawShutdownText(hdc, "是 (Y)", yesRect, shutdownRGB(24, 38, 25), textSingleLine|textVCenter)
	restoreShutdownFont(hdc, labelFont, oldLabelFont)

	for _, brush := range []uintptr{background, headerBrush, border, accent, button, buttonQuiet} {
		if brush != 0 {
			deleteObject.Call(brush)
		}
	}
	endPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	return 0
}

func shutdownConfirmationWindowProcedure(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmPaint:
		return paintShutdownConfirmation(hwnd)
	case wmEraseBkgnd:
		return 1
	case wmLButtonUp:
		x := int(int16(uint16(lParam)))
		y := int(int16(uint16(lParam >> 16)))
		var client shutdownRect
		getClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
		if y <= 56 && x >= int(client.right)-48 {
			shutdownConfirmResult.Store(idNo)
			destroyWindow.Call(hwnd)
			return 0
		}
		if y >= int(client.bottom)-58 && y <= int(client.bottom)-20 {
			if x >= int(client.right)-130 && x <= int(client.right)-24 {
				shutdownConfirmResult.Store(idYes)
				destroyWindow.Call(hwnd)
			} else if x >= int(client.right)-248 && x <= int(client.right)-142 {
				shutdownConfirmResult.Store(idNo)
				destroyWindow.Call(hwnd)
			}
		}
		return 0
	case wmKeyDown:
		switch wParam {
		case vkY:
			shutdownConfirmResult.Store(idYes)
			destroyWindow.Call(hwnd)
			return 0
		case vkN, vkReturn, vkEscape:
			shutdownConfirmResult.Store(idNo)
			destroyWindow.Call(hwnd)
			return 0
		}
	case wmClose:
		shutdownConfirmResult.Store(idNo)
		destroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		postQuitMessage.Call(0)
		return 0
	}
	result, _, _ := defWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

// showShutdownConfirmation replaces the plain Windows MessageBox with the
// same forest-green visual language as the safe-shutdown progress window.
// It is an ordinary centered window, stays in normal z-order, and defaults to No.
func showShutdownConfirmation() bool {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	shutdownConfirmResult.Store(idNo)
	instance, _, _ := getModuleHandleW.Call(0)
	cursor, _, _ := loadCursorW.Call(0, 32512)
	class := shutdownWindowClass{
		size:       uint32(unsafe.Sizeof(shutdownWindowClass{})),
		windowProc: shutdownConfirmWindowProc,
		instance:   instance,
		cursor:     cursor,
		className:  shutdownConfirmClassName,
	}
	atom, _, _ := registerClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 && syscall.GetLastError() != syscall.Errno(1410) {
		return false
	}
	screenWidth, _, _ := getSystemMetrics.Call(smCxScreen)
	screenHeight, _, _ := getSystemMetrics.Call(smCyScreen)
	x := int32((int(screenWidth) - confirmWindowWidth) / 2)
	y := int32((int(screenHeight) - confirmWindowHeight) / 2)
	title := syscall.StringToUTF16Ptr("关闭 BlockCraft")
	hwnd, _, _ := createWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(shutdownConfirmClassName)),
		uintptr(unsafe.Pointer(title)),
		wsPopup|wsBorder,
		uintptr(x), uintptr(y), uintptr(confirmWindowWidth), uintptr(confirmWindowHeight),
		0, 0, instance, 0,
	)
	if hwnd == 0 {
		return false
	}
	showWindow.Call(hwnd, swShow)
	updateWindow.Call(hwnd)
	setForegroundWindow.Call(hwnd)
	for {
		var message shutdownMessage
		result, _, _ := getMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if result == 0 || result == ^uintptr(0) {
			break
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
	return shutdownConfirmResult.Load() == idYes
}
