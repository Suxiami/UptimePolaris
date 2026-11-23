package polaris

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

func httpOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme) + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}

func monitorRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return fmt.Errorf("too many redirects")
	}
	previous := via[len(via)-1]
	if req.URL.User != nil || req.URL.Scheme != "http" && req.URL.Scheme != "https" || previous.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("unsafe redirect")
	}
	if httpOrigin(req.URL) != httpOrigin(previous.URL) && req.Body != nil && req.Body != http.NoBody {
		return fmt.Errorf("unsafe redirect body")
	}
	for _, step := range via {
		if httpOrigin(step.URL) != httpOrigin(req.URL) {
			for name := range req.Header {
				if !strings.EqualFold(name, "Accept") && !strings.EqualFold(name, "User-Agent") {
					req.Header.Del(name)
				}
			}
			req.Host = ""
			break
		}
	}
	return nil
}

func publicAddressDialer(
	lookup func(context.Context, string, string) ([]netip.Addr, error),
	dial func(context.Context, string, string) (net.Conn, error),
) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("invalid destination")
		}
		addresses, err := lookup(ctx, "ip", host)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("destination unavailable")
		}
		for _, ip := range addresses {
			if !publicSubscriptionIP(ip) {
				return nil, fmt.Errorf("destination blocked")
			}
		}
		var last error
		for _, ip := range addresses {
			connection, err := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return connection, nil
			}
			last = err
		}
		return nil, last
	}
}
