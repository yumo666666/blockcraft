package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// trayPanelPost performs the same token login as the browser, then sends one
// authenticated local API request using the returned session cookie. The panel
// token is a login credential, not a session id, so it must not be sent as
// ?token=... to authenticated API endpoints.
func trayPanelPost(port int, token, path string, timeout time.Duration) error {
	return trayPanelRequest(port, token, http.MethodPost, path, timeout, nil)
}

func trayPanelGetJSON(port int, token, path string, timeout time.Duration, output any) error {
	return trayPanelRequest(port, token, http.MethodGet, path, timeout, output)
}

func trayPanelRequest(port int, token, method, path string, timeout time.Duration, output any) error {
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{Proxy: nil},
	}

	loginBody, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return err
	}
	loginRequest, err := http.NewRequest(http.MethodPost, baseURL+"/api/login", bytes.NewReader(loginBody))
	if err != nil {
		return err
	}
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("x-blockcraft", "1")
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		return fmt.Errorf("连接面板登录接口失败：%w", err)
	}
	loginResponseBody, _ := io.ReadAll(io.LimitReader(loginResponse.Body, 16*1024))
	_ = loginResponse.Body.Close()
	if loginResponse.StatusCode < 200 || loginResponse.StatusCode >= 300 {
		return panelResponseError(loginResponseBody, loginResponse.StatusCode)
	}

	var sessionCookie *http.Cookie
	for _, cookie := range loginResponse.Cookies() {
		if cookie.Name == "bc_session" {
			sessionCookie = cookie
			break
		}
	}
	if sessionCookie == nil || sessionCookie.Value == "" {
		return fmt.Errorf("面板登录成功，但没有返回登录会话")
	}

	request, err := http.NewRequest(method, baseURL+path, nil)
	if err != nil {
		return err
	}
	request.AddCookie(sessionCookie)
	request.Header.Set("x-blockcraft", "1")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("连接面板操作接口失败：%w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		if output != nil && len(body) > 0 {
			if err := json.Unmarshal(body, output); err != nil {
				return fmt.Errorf("读取面板响应失败：%w", err)
			}
		}
		return nil
	}
	return panelResponseError(body, response.StatusCode)
}

func panelResponseError(body []byte, status int) error {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error.Message != "" {
		return fmt.Errorf("%s", payload.Error.Message)
	}
	return fmt.Errorf("面板返回 HTTP %d", status)
}
