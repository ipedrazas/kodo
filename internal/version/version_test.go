package version

import "testing"

func TestStringDefaults(t *testing.T) {
	if got, want := String(), "dev (none)"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}
