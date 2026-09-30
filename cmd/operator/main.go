// Command operator reconciles kodo Fleets, Blueprints and Workspaces.
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
	"github.com/ipedrazas/kodo/internal/controller"
	"github.com/ipedrazas/kodo/internal/kernelapi"
	"github.com/ipedrazas/kodo/internal/version"
)

func main() {
	var metricsAddr, probeAddr string
	var leaderElect bool
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "Address the metrics endpoint binds to; 0 disables it.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Address the health probes bind to.")
	flag.BoolVar(&leaderElect, "leader-elect", false, "Elect a leader, so only one replica reconciles at a time.")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	log := ctrl.Log.WithName("setup")
	log.Info("starting kodo operator", "version", version.String())

	scheme := runtime.NewScheme()
	must(clientgoscheme.AddToScheme(scheme))
	must(kodov1.AddToScheme(scheme))

	cfg := ctrl.GetConfigOrDie()
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         leaderElect,
		LeaderElectionID:       "operator.kodo.dev",
	})
	must(err)

	clientset, err := kubernetes.NewForConfig(cfg)
	must(err)
	kernel := kernelapi.New(clientset.CoreV1().RESTClient())

	must((&controller.FleetReconciler{Client: mgr.GetClient(), Scheme: scheme}).SetupWithManager(mgr))
	must((&controller.BlueprintReconciler{Client: mgr.GetClient(), Kernel: kernel}).SetupWithManager(mgr))
	must((&controller.WorkspaceReconciler{Client: mgr.GetClient(), Kernel: kernel}).SetupWithManager(mgr))
	must(mgr.AddHealthzCheck("healthz", healthz.Ping))
	must(mgr.AddReadyzCheck("readyz", healthz.Ping))

	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "operator stopped")
		os.Exit(1)
	}
}

func must(err error) {
	if err != nil {
		ctrl.Log.WithName("setup").Error(err, "setup failed")
		os.Exit(1)
	}
}
