// Command agent is the kodo agent: the chat at app.<domain>/chat/, where the
// agent plans, writes JavaScript and runs it in ephemeral cells with the
// grants the user gave the chat. It is stateless and has no authority of its
// own: sessions live in the kernel, and every call it makes is one the user,
// or the turn the user started, could make.
//
// Configuration is from the environment:
//
//	AGENT_ADDR        where it listens (default :8080)
//	KERNEL_URL        the fleet's kernel API, e.g. http://kodo.kodo.svc (required)
//	AGENT_MODEL       the model it thinks with; new sessions are granted
//	                  inference:model/<AGENT_MODEL>:invoke (default agent)
//	AGENT_MAX_STEPS   model calls per turn, at most (default 10)
//	AGENT_MAX_TOKENS  max_tokens of each model call (default 2048)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ipedrazas/kodo/internal/agent"
	"github.com/ipedrazas/kodo/internal/version"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	if err := run(log); err != nil {
		log.Error("agent stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	kernelURL := os.Getenv("KERNEL_URL")
	if kernelURL == "" {
		return errors.New("KERNEL_URL is required")
	}
	steps, err := intEnv("AGENT_MAX_STEPS", 10)
	if err != nil {
		return err
	}
	tokens, err := intEnv("AGENT_MAX_TOKENS", 2048)
	if err != nil {
		return err
	}
	s := &agent.Server{
		Kernel: agent.NewKernel(kernelURL),
		Config: agent.Config{Model: env("AGENT_MODEL", "agent"), MaxSteps: steps, MaxTokens: tokens},
		Log:    log,
	}
	srv := &http.Server{Addr: env("AGENT_ADDR", ":8080"), Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errs := make(chan error, 1)
	go func() { errs <- srv.ListenAndServe() }()
	log.Info("agent started", "version", version.String(), "addr", srv.Addr, "kernel", kernelURL, "model", s.Config.Model)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	// Turns in progress are interrupted and say so before the pod goes.
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	s.Shutdown(shutdown)
	log.Info("agent stopped")
	return nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func intEnv(name string, fallback int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive number", name)
	}
	return n, nil
}
