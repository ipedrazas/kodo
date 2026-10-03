package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
	"github.com/ipedrazas/kodo/internal/kernelapi"
)

// reportKernel keeps the reports it is sent.
type reportKernel struct {
	reports []ClusterReport
	paths   []string
}

func (k *reportKernel) Do(_ context.Context, _ kernelapi.Target, method, path string, body any) (kernelapi.Response, error) {
	k.paths = append(k.paths, method+" "+path)
	data, _ := json.Marshal(body)
	var r ClusterReport
	_ = json.Unmarshal(data, &r)
	k.reports = append(k.reports, r)
	return kernelapi.Response{Status: http.StatusNoContent}, nil
}

func inferenceObjects() []client.Object {
	route := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "aigateway.envoyproxy.io/v1beta1",
		"kind":       "AIGatewayRoute",
		"metadata":   map[string]any{"name": "kodo-inference", "namespace": "kodo-inference"},
		"spec": map[string]any{"rules": []any{
			map[string]any{
				"name":        "agent",
				"matches":     []any{map[string]any{"headers": []any{map[string]any{"name": "x-ai-eg-model", "value": "agent"}}}},
				"backendRefs": []any{map[string]any{"name": "openrouter", "modelNameOverride": "deepseek/deepseek-v4-flash"}},
				"timeouts":    map[string]any{"request": "120s"},
			},
			map[string]any{
				"name":        "sim",
				"matches":     []any{map[string]any{"headers": []any{map[string]any{"name": "x-ai-eg-model", "value": "sim"}}}},
				"backendRefs": []any{map[string]any{"name": "sim", "modelNameOverride": "kodo-sim", "weight": int64(1)}},
			},
		}},
	}}
	policy := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1",
		"kind":       "BackendTrafficPolicy",
		"metadata":   map[string]any{"name": "kodo-inference-budgets", "namespace": "kodo-inference"},
		"spec": map[string]any{"rateLimit": map[string]any{"type": "Global", "global": map[string]any{"rules": []any{
			map[string]any{
				"clientSelectors": []any{map[string]any{"headers": []any{map[string]any{"name": "x-kodo-user", "type": "Distinct"}}}},
				"limit":           map[string]any{"requests": int64(60), "unit": "Minute"},
			},
			map[string]any{
				"clientSelectors": []any{map[string]any{"headers": []any{map[string]any{"name": "x-kodo-user", "type": "Exact", "value": "sub-bob"}}}},
				"limit":           map[string]any{"requests": int64(20), "unit": "Hour"},
				"cost":            map[string]any{"response": map[string]any{"from": "Metadata"}},
			},
		}}}},
	}}
	return []client.Object{route, policy}
}

func TestClusterReportGoesToTheKernel(t *testing.T) {
	f := testFleet()
	f.Spec.Inference = &kodov1.InferenceRef{}
	f.Status.ReadyReplicas, f.Status.Celld, f.Status.Kernel = 3, "ghcr.io/denoland/celld:0.6.0", "kernel:1"
	f.Status.Conditions = []metav1.Condition{{Type: ConditionReady, Status: metav1.ConditionTrue, Reason: "Ready"}}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: f.Name + "-0", Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec:       corev1.PodSpec{NodeName: "k3s-1"},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: []corev1.ContainerStatus{{RestartCount: 2}},
		},
	}
	other := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "unrelated", Namespace: f.Namespace}}
	token := adminToken()
	token.Name, token.Namespace = AdminTokenSecretName(f), f.Namespace
	objs := append([]client.Object{f, pod, other, token}, inferenceObjects()...)
	c := fake.NewClientBuilder().WithScheme(testScheme(t)).WithObjects(objs...).Build()
	kernel := &reportKernel{}
	r := &ClusterReporter{Client: c, Kernel: kernel}
	res, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(f)})
	if err != nil {
		t.Fatal(err)
	}
	if res.RequeueAfter != reportEvery {
		t.Fatalf("requeue %v", res.RequeueAfter)
	}
	if len(kernel.paths) != 1 || kernel.paths[0] != "PUT /admin/cluster" {
		t.Fatalf("calls %v", kernel.paths)
	}
	rep := kernel.reports[0]
	if rep.Fleet.ReadyReplicas != 3 || rep.Fleet.Kernel != "kernel:1" || len(rep.Fleet.Conditions) != 1 {
		t.Fatalf("fleet %+v", rep.Fleet)
	}
	if len(rep.Nodes) != 1 || !rep.Nodes[0].Ready || rep.Nodes[0].Restarts != 2 || rep.Nodes[0].Node != "k3s-1" {
		t.Fatalf("nodes %+v", rep.Nodes)
	}
	if rep.InferenceRoute != "kodo-inference/kodo-inference" || len(rep.Models) != 2 ||
		rep.Models[0].Name != "agent" || rep.Models[0].Backends[0].Model != "deepseek/deepseek-v4-flash" || rep.Models[0].Timeout != "120s" ||
		rep.Models[1].Backends[0].Weight != 1 {
		t.Fatalf("models %+v", rep.Models)
	}
	if len(rep.RateLimits) != 2 || rep.RateLimits[0].Headers[0] != "x-kodo-user (each)" || rep.RateLimits[0].Limit != 60 ||
		rep.RateLimits[0].Cost != "requests" || rep.RateLimits[1].Headers[0] != "x-kodo-user = sub-bob" || rep.RateLimits[1].Cost != "tokens" {
		t.Fatalf("rate limits %+v", rep.RateLimits)
	}
	if len(rep.Errors) != 0 {
		t.Fatalf("errors %v", rep.Errors)
	}
}

func TestClusterReportWithoutInference(t *testing.T) {
	f := testFleet()
	c := fake.NewClientBuilder().WithScheme(testScheme(t)).WithObjects(f).Build()
	rep := (&ClusterReporter{Client: c, Kernel: &reportKernel{}}).Report(context.Background(), f)
	if rep.Models != nil || rep.RateLimits != nil || rep.InferenceRoute != "" || len(rep.Nodes) != 0 {
		t.Fatalf("report %+v", rep)
	}
}

func TestKernelJobNamesThePlatformAdmins(t *testing.T) {
	f := testFleet()
	before := kernelJobName(f)
	f.Spec.Admins = &kodov1.AdminsSpec{Group: "kodo-admins", GroupsClaim: "groups", Emails: []string{"a@x", "b@x"}}
	if kernelJobName(f) == before {
		t.Fatal("changing the admins does not redeploy the kernel")
	}
	env := map[string]string{}
	for _, e := range desiredKernelJob(f).Spec.Template.Spec.Containers[0].Env {
		env[e.Name] = e.Value
	}
	if env["PLATFORM_ADMIN_GROUP"] != "kodo-admins" || env["PLATFORM_ADMIN_GROUPS_CLAIM"] != "groups" || env["PLATFORM_ADMIN_EMAILS"] != "a@x,b@x" {
		t.Fatalf("env %v", env)
	}
}
