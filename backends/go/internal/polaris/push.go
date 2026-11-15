package polaris

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const pushMessageMaxLength = 200
const pushBodyMaxBytes = 4096

var pushIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var pushTokenPattern = regexp.MustCompile(`^[0-9a-f]{48}$`)

func validPushCredentials(value Object) bool {
	return len(value) == 2 && pushIDPattern.MatchString(str(value, "id")) && pushTokenPattern.MatchString(str(value, "push_token"))
}

func pushAuthorized(m Object, secret string) bool {
	expected := str(m, "push_token")
	if expected == "" {
		expected = strings.Repeat("0", 48)
	}
	matches := constantEqual(digest(secret), digest(expected))
	return matches && secret != "" && str(m, "push_token") != "" && str(m, "type") == "push" && boolean(m["active"])
}

func pushMethodNotAllowed(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Allow", "POST")
	return failure("method_not_allowed", http.StatusMethodNotAllowed)
}

func (a *App) publicPush(w http.ResponseWriter, r *http.Request) error {
	unauthorized := func() error {
		w.Header().Set("WWW-Authenticate", "Bearer")
		return failure("unauthorized", http.StatusUnauthorized)
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, pushBodyMaxBytes+1))
	if err != nil {
		return failure("invalid_request", http.StatusBadRequest)
	}
	if len(data) > pushBodyMaxBytes {
		return failure("payload_too_large", http.StatusRequestEntityTooLarge)
	}
	scheme, secret, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") || strings.ContainsAny(secret, " \t\r\n") {
		secret = ""
	}
	id := r.PathValue("id")
	monitor, err := a.store.get(r.Context(), "monitor", id)
	if err != nil {
		return err
	}
	if !pushAuthorized(monitor, secret) {
		return unauthorized()
	}
	if r.URL.RawQuery != "" {
		return failure("invalid_request", http.StatusBadRequest)
	}
	input := Object{}
	if strings.TrimSpace(string(data)) != "" {
		mediaType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
		if mediaType != "application/json" {
			return failure("unsupported_media_type", http.StatusUnsupportedMediaType)
		}
		if json.Unmarshal(data, &input) != nil || input == nil {
			return failure("invalid_request", http.StatusBadRequest)
		}
	}
	if !knownFields(input, []string{"status", "message"}) {
		return failure("invalid_request", http.StatusBadRequest)
	}
	status := 1
	if value, exists := input["status"]; exists {
		n, ok := value.(float64)
		if !ok || n != 0 && n != 1 && n != 2 {
			return failure("push_status_invalid", http.StatusBadRequest)
		}
		status = int(n)
	}
	message := ""
	if value, exists := input["message"]; exists {
		text, ok := value.(string)
		if !ok || utf8.RuneCountInString(text) > pushMessageMaxLength {
			return failure("push_message_invalid", http.StatusBadRequest)
		}
		message = text
	}
	err = a.store.mutate(r.Context(), func(t *transaction) error {
		current, err := t.get("monitor", id)
		if err != nil {
			return err
		}
		if !pushAuthorized(current, secret) {
			return unauthorized()
		}
		return t.put("push", id, Object{"ts": time.Now().Unix(), "status": status, "message": message})
	})
	if err != nil {
		return err
	}
	respond(w, http.StatusOK, Object{"ok": true})
	return nil
}

func pushReading(last Object, intervalSec, now int64) CheckResult {
	if last == nil {
		return CheckResult{Status: 0, Message: "no push received"}
	}
	ageSec := now - integer(last, "ts")
	if ageSec > intervalSec {
		return CheckResult{Status: 0, Message: fmt.Sprintf("no push received in %ds", ageSec)}
	}
	return CheckResult{Status: int(integer(last, "status")), Message: str(last, "message")}
}
