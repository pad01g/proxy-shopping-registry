// Command registrycheck feeds a built events.json to the Go node's trust store (proxy-shopping-go,
// node/internal/trust), as a node would receive it from a relay or a trust bundle, and prints what it accepts.
// It must be built inside the node module (internal packages): CI copies it to node/cmd/registrycheck.
//
//	go run ./cmd/registrycheck <events.json> <coordinator pk> <network> <expected entries>
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/nbd-wtf/go-nostr"

	"github.com/pad01g/proxy-shopping-go/node/internal/trust"
)

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: registrycheck <events.json> <coordinator pk> <network> <expected entries>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	check(err)
	var file struct {
		Events []nostr.Event `json:"events"`
	}
	check(json.Unmarshal(data, &file))
	want, err := strconv.Atoi(os.Args[4])
	check(err)
	coord, network := os.Args[2], os.Args[3]
	s, err := trust.NewStore(nil)
	check(err)
	s.SetScope([]string{coord}, network)
	for i := range file.Events {
		ev := &file.Events[i]
		if err := trust.Validate(ev); err != nil {
			fail("event %d (kind %d): %v", i, ev.Kind, err)
		}
		if _, err := s.Put(ev); err != nil {
			fail("event %d (kind %d): store refuses it: %v", i, ev.Kind, err)
		}
	}
	rows := s.Effective([]string{coord}, network)
	if len(rows) != want {
		fail("effective set has %d entries, want %d", len(rows), want)
	}
	fmt.Printf("the Go trust store accepts all %d events; %d effective entries\n", len(file.Events), len(rows))
}

func check(err error) {
	if err != nil {
		fail("%v", err)
	}
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", a...)
	os.Exit(1)
}
