package polaris

import "testing"

func TestThemeUpgradeReplacesSelection(t *testing.T) {
	s := newTestServer(t)
	manifest := themeManifest()
	code, first := s.upload(t, packageZip(t, manifest, nil))
	expectStatus(t, code, 200, first)
	_, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	config := object(state["config"])
	page := object(object(config["pages"])["monitor"])
	page["theme"] = Object{"short": "fixture", "version": first["versionKey"], "theme": "status"}
	page["themeOptions"] = Object{"accent": "#abcdef"}
	page["headCode"] = "<meta name=custom>"
	page["contentHtml"] = "<b>Custom</b>"
	code, saved := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, saved)
	code, saved = s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": saved["revision"]}, true)
	expectStatus(t, code, 200, saved)
	manifest["version"] = "2.0.0"
	code, upgraded := s.upload(t, packageZip(t, manifest, nil))
	expectStatus(t, code, 200, upgraded)
	_, next := s.request(t, "GET", "/api/admin/presentation", nil, true)
	page = object(object(object(next["config"])["pages"])["monitor"])
	if str(object(page["theme"]), "version") != str(upgraded, "versionKey") || str(object(page["themeOptions"]), "accent") != "#abcdef" || page["headCode"] != "<meta name=custom>" || page["contentHtml"] != "<b>Custom</b>" {
		t.Fatal("upgrade lost the selected theme or page configuration", page)
	}
	_, listed := s.request(t, "GET", "/api/themes", nil, true)
	versions := array(object(array(listed["themes"])[0])["versions"])
	if len(versions) != 1 || str(object(versions[0]), "versionKey") != str(upgraded, "versionKey") {
		t.Fatal("theme list includes an obsolete version", listed)
	}
	manifest["version"] = "3.0.0"
	object(array(manifest["themes"])[0])["id"] = "renamed"
	code, rejected := s.upload(t, packageZip(t, manifest, nil))
	expectStatus(t, code, 409, rejected)
	_, unchanged := s.request(t, "GET", "/api/admin/presentation", nil, true)
	if encode(unchanged) != encode(next) {
		t.Fatal("rejected upgrade changed page settings", unchanged)
	}
}
