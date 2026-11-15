package polaris

import "testing"

func TestPresentationManualDomains(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/api/admin/presentation/domains", "/api/admin/presentation/domains?service=uptime-polaris"} {
		code, result := s.request(t, "GET", path, nil, true)
		expectStatus(t, code, 404, result)
		if str(result, "error") != "not_found" {
			t.Fatal(result)
		}
	}
	code, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	expectStatus(t, code, 200, state)
	config := object(state["config"])
	domains := []Object{{"hostname": "status.example.com", "page": "monitor"}, {"hostname": "servers.example.com", "page": "agent"}}
	config["domains"] = domains
	for _, enabled := range []bool{true, false, true} {
		config["agentEnabled"] = enabled
		code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
		expectStatus(t, code, 200, result)
		code, state = s.request(t, "GET", "/api/admin/presentation", nil, true)
		expectStatus(t, code, 200, state)
		config = object(state["config"])
		if config["agentEnabled"] != enabled || encode(config["domains"]) != encode(domains) {
			t.Fatal("page toggle changed manual mappings", state)
		}
	}
}
