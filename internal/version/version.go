// Package version reports the build version shared by all kodo binaries.
package version

import "fmt"

// Set at build time with -ldflags "-X github.com/ipedrazas/kodo/internal/version.<name>=<value>".
var (
	version = "dev"
	commit  = "none"
)

// String returns the version and commit in a form suitable for --version output and logs.
func String() string {
	return fmt.Sprintf("%s (%s)", version, commit)
}
