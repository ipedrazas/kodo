package controller

import (
	"context"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrlmgr "sigs.k8s.io/controller-runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
)

// How often each Fleet's kernel hears about the cluster.
const reportEvery = time.Minute

// ClusterReporter tells each Fleet's kernel, every minute, what the cluster
// says about it: the Fleet's status and nodes, and the inference gateway's
// models and rate limits. Fleet pods cannot read the Kubernetes API, so this
// is how the admin dashboard shows cluster configuration, read-only.
type ClusterReporter struct {
	ctrl.Client
	Kernel Kernel
}

// ClusterReport is what the kernel stores and the dashboard shows.
type ClusterReport struct {
	Fleet          FleetReport     `json:"fleet"`
	Nodes          []NodeReport    `json:"nodes"`
	InferenceRoute string          `json:"inferenceRoute,omitempty"`
	Models         []ModelReport   `json:"models,omitempty"`
	RateLimits     []RateLimitRule `json:"rateLimits,omitempty"`
	Errors         []string        `json:"errors,omitempty"`
}

type FleetReport struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Replicas      int32             `json:"replicas"`
	ReadyReplicas int32             `json:"readyReplicas"`
	Celld         string            `json:"celld"`
	Kernel        string            `json:"kernel"`
	Conditions    []ConditionReport `json:"conditions,omitempty"`
}

type ConditionReport struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type NodeReport struct {
	Name      string `json:"name"`
	Ready     bool   `json:"ready"`
	Phase     string `json:"phase"`
	Restarts  int32  `json:"restarts"`
	Node      string `json:"node,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
}

// ModelReport is one model name of the inference gateway, as gadgets grant
// it (inference:model/<name>:invoke), and what serves it.
type ModelReport struct {
	Name     string          `json:"name"`
	Backends []BackendReport `json:"backends"`
	Timeout  string          `json:"timeout,omitempty"`
}

type BackendReport struct {
	Backend string `json:"backend"`
	Model   string `json:"model,omitempty"`
	Weight  int64  `json:"weight,omitempty"`
}

// RateLimitRule is one rule of a BackendTrafficPolicy on the gateway.
type RateLimitRule struct {
	Policy string `json:"policy"`
	// The headers it counts by, e.g. "x-kodo-user (each)".
	Headers []string `json:"headers"`
	Limit   int64    `json:"limit"`
	Unit    string   `json:"unit"`
	// "requests", or "tokens" for a rule charged with each response's tokens.
	Cost string `json:"cost"`
}

var (
	routeList  = schema.GroupVersionKind{Group: "aigateway.envoyproxy.io", Version: "v1beta1", Kind: "AIGatewayRouteList"}
	policyList = schema.GroupVersionKind{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Kind: "BackendTrafficPolicyList"}
)

// +kubebuilder:rbac:groups=aigateway.envoyproxy.io,resources=aigatewayroutes,verbs=get;list
// +kubebuilder:rbac:groups=gateway.envoyproxy.io,resources=backendtrafficpolicies,verbs=get;list

func (r *ClusterReporter) Reconcile(ctx context.Context, req ctrlmgr.Request) (ctrlmgr.Result, error) {
	var f kodov1.Fleet
	if err := r.Get(ctx, req.NamespacedName, &f); err != nil {
		return ctrlmgr.Result{}, ctrl.IgnoreNotFound(err)
	}
	if !f.DeletionTimestamp.IsZero() {
		return ctrlmgr.Result{}, nil
	}
	report := r.Report(ctx, &f)
	target, err := kernelTarget(ctx, r.Client, f.Namespace, f.Name)
	if err == nil {
		res, doErr := r.Kernel.Do(ctx, target, http.MethodPut, "/admin/cluster", report)
		if err = doErr; err == nil && !res.OK() {
			err = fmt.Errorf("the kernel refused the report: %d %s", res.Status, res.Error())
		}
	}
	if err != nil {
		// A fleet that is starting, or runs a kernel from before Phase 12,
		// hears next time.
		log.FromContext(ctx).V(1).Info("reporting the cluster", "fleet", f.Name, "err", err.Error())
	}
	return ctrlmgr.Result{RequeueAfter: reportEvery}, nil
}

// Report gathers what the cluster says about a Fleet. What cannot be read
// is listed in Errors rather than failing the report.
func (r *ClusterReporter) Report(ctx context.Context, f *kodov1.Fleet) ClusterReport {
	rep := ClusterReport{
		Fleet: FleetReport{
			Name: f.Name, Namespace: f.Namespace, Replicas: f.Spec.Replicas, ReadyReplicas: f.Status.ReadyReplicas,
			Celld: f.Status.Celld, Kernel: f.Status.Kernel,
		},
		Nodes: []NodeReport{},
	}
	for _, c := range f.Status.Conditions {
		rep.Fleet.Conditions = append(rep.Fleet.Conditions, ConditionReport{Type: c.Type, Status: string(c.Status), Reason: c.Reason, Message: c.Message})
	}
	var pods corev1.PodList
	if err := r.List(ctx, &pods, ctrl.InNamespace(f.Namespace), ctrl.MatchingLabels(nodeSelector(f))); err != nil {
		rep.Errors = append(rep.Errors, "nodes: "+err.Error())
	}
	for _, p := range pods.Items {
		n := NodeReport{Name: p.Name, Phase: string(p.Status.Phase), Node: p.Spec.NodeName}
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodReady {
				n.Ready = c.Status == corev1.ConditionTrue
			}
		}
		for _, cs := range p.Status.ContainerStatuses {
			n.Restarts += cs.RestartCount
		}
		if p.Status.StartTime != nil {
			n.StartedAt = p.Status.StartTime.UTC().Format(time.RFC3339)
		}
		rep.Nodes = append(rep.Nodes, n)
	}

	if f.Spec.Inference == nil {
		return rep
	}
	ns := f.Spec.Inference.Namespace
	if ns == "" {
		ns = "kodo-inference"
	}
	routes := &unstructured.UnstructuredList{}
	routes.SetGroupVersionKind(routeList)
	if err := r.List(ctx, routes, ctrl.InNamespace(ns)); err != nil {
		rep.Errors = append(rep.Errors, "models: "+err.Error())
	}
	for _, route := range routes.Items {
		if rep.InferenceRoute == "" {
			rep.InferenceRoute = ns + "/" + route.GetName()
		}
		rep.Models = append(rep.Models, models(route.Object)...)
	}
	policies := &unstructured.UnstructuredList{}
	policies.SetGroupVersionKind(policyList)
	if err := r.List(ctx, policies, ctrl.InNamespace(ns)); err != nil {
		rep.Errors = append(rep.Errors, "rate limits: "+err.Error())
	}
	for _, p := range policies.Items {
		rep.RateLimits = append(rep.RateLimits, rateLimits(p.GetName(), p.Object)...)
	}
	return rep
}

// models reads an AIGatewayRoute's rules: the model each matches on its
// x-ai-eg-model header, and the backends that serve it.
func models(route map[string]any) []ModelReport {
	var out []ModelReport
	rules, _, _ := unstructured.NestedSlice(route, "spec", "rules")
	for _, raw := range rules {
		rule, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		m := ModelReport{Backends: []BackendReport{}}
		matches, _, _ := unstructured.NestedSlice(rule, "matches")
		for _, match := range matches {
			headers, _, _ := unstructured.NestedSlice(asMap(match), "headers")
			for _, h := range headers {
				if name, _, _ := unstructured.NestedString(asMap(h), "name"); name == "x-ai-eg-model" {
					m.Name, _, _ = unstructured.NestedString(asMap(h), "value")
				}
			}
		}
		if m.Name == "" {
			m.Name, _, _ = unstructured.NestedString(rule, "name")
		}
		refs, _, _ := unstructured.NestedSlice(rule, "backendRefs")
		for _, ref := range refs {
			b := BackendReport{}
			b.Backend, _, _ = unstructured.NestedString(asMap(ref), "name")
			b.Model, _, _ = unstructured.NestedString(asMap(ref), "modelNameOverride")
			b.Weight, _, _ = unstructured.NestedInt64(asMap(ref), "weight")
			m.Backends = append(m.Backends, b)
		}
		m.Timeout, _, _ = unstructured.NestedString(rule, "timeouts", "request")
		out = append(out, m)
	}
	return out
}

// rateLimits reads a BackendTrafficPolicy's global rate limit rules.
func rateLimits(policy string, obj map[string]any) []RateLimitRule {
	var out []RateLimitRule
	rules, _, _ := unstructured.NestedSlice(obj, "spec", "rateLimit", "global", "rules")
	for _, raw := range rules {
		rule := asMap(raw)
		l := RateLimitRule{Policy: policy, Headers: []string{}, Cost: "requests"}
		selectors, _, _ := unstructured.NestedSlice(rule, "clientSelectors")
		for _, s := range selectors {
			headers, _, _ := unstructured.NestedSlice(asMap(s), "headers")
			for _, h := range headers {
				name, _, _ := unstructured.NestedString(asMap(h), "name")
				kind, _, _ := unstructured.NestedString(asMap(h), "type")
				value, _, _ := unstructured.NestedString(asMap(h), "value")
				switch kind {
				case "Distinct":
					l.Headers = append(l.Headers, name+" (each)")
				case "", "Exact":
					l.Headers = append(l.Headers, name+" = "+value)
				default:
					l.Headers = append(l.Headers, name+" ("+kind+")")
				}
			}
		}
		l.Limit, _, _ = unstructured.NestedInt64(rule, "limit", "requests")
		l.Unit, _, _ = unstructured.NestedString(rule, "limit", "unit")
		if _, ok, _ := unstructured.NestedMap(rule, "cost", "response"); ok {
			l.Cost = "tokens"
		}
		out = append(out, l)
	}
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func (r *ClusterReporter) SetupWithManager(mgr ctrlmgr.Manager) error {
	return ctrlmgr.NewControllerManagedBy(mgr).For(&kodov1.Fleet{}).Named("clusterreport").Complete(r)
}
