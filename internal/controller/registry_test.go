package controller

import (
	"context"
	"errors"
	"net/http"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
	"github.com/ipedrazas/kodo/internal/kernelapi"
)

// fakeKernel answers kernel API calls from a table keyed by "METHOD path".
type fakeKernel struct {
	answers map[string]kernelapi.Response
	err     error
	calls   []string
}

func (k *fakeKernel) Do(_ context.Context, _, _, method, path string, _ any) (kernelapi.Response, error) {
	k.calls = append(k.calls, method+" "+path)
	if k.err != nil {
		return kernelapi.Response{}, k.err
	}
	if res, ok := k.answers[method+" "+path]; ok {
		return res, nil
	}
	return kernelapi.Response{Status: http.StatusNotFound, Body: []byte(`{"error":"not found"}`)}, nil
}

func answer(status int, body string) kernelapi.Response {
	return kernelapi.Response{Status: status, Body: []byte(body)}
}

const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func publishBlueprint(t *testing.T, kernel *fakeKernel) (kodov1.Blueprint, ctrl.Result) {
	t.Helper()
	bp := &kodov1.Blueprint{
		ObjectMeta: metav1.ObjectMeta{Name: "notes-1", Namespace: "kodo", Generation: 1},
		Spec: kodov1.BlueprintSpec{
			Fleet: "kodo", Blueprint: "notes", Version: "1",
			Source: corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "notes"}, Key: "notes.js"},
		},
	}
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "notes", Namespace: "kodo"}, Data: map[string]string{"notes.js": "export class App {}"}}
	c := fake.NewClientBuilder().WithScheme(testScheme(t)).WithObjects(bp, cm).WithStatusSubresource(&kodov1.Blueprint{}).Build()
	r := &BlueprintReconciler{Client: c, Kernel: kernel}
	res, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(bp)})
	if err != nil {
		t.Fatal(err)
	}
	var got kodov1.Blueprint
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(bp), &got); err != nil {
		t.Fatal(err)
	}
	return got, res
}

func published(bp kodov1.Blueprint) *metav1.Condition {
	return meta.FindStatusCondition(bp.Status.Conditions, ConditionPublished)
}

func TestBlueprintPublishes(t *testing.T) {
	bp, _ := publishBlueprint(t, &fakeKernel{answers: map[string]kernelapi.Response{
		"POST /bundles":           answer(201, `{"digest":"`+digest+`"}`),
		"PUT /blueprints/notes/1": answer(201, `{}`),
	}})
	if c := published(bp); c == nil || c.Status != metav1.ConditionTrue || bp.Status.Digest != digest {
		t.Fatalf("condition %+v digest %q", c, bp.Status.Digest)
	}
}

func TestBlueprintAlreadyPublishedWithSameBundle(t *testing.T) {
	bp, _ := publishBlueprint(t, &fakeKernel{answers: map[string]kernelapi.Response{
		"POST /bundles":           answer(201, `{"digest":"`+digest+`"}`),
		"PUT /blueprints/notes/1": answer(409, `{"error":"notes 1 is already published"}`),
		"GET /blueprints/notes":   answer(200, `{"versions":[{"version":"1","bundle":"`+digest+`"}]}`),
	}})
	if c := published(bp); c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("condition %+v", c)
	}
}

func TestBlueprintConflictsWithAnotherBundle(t *testing.T) {
	bp, _ := publishBlueprint(t, &fakeKernel{answers: map[string]kernelapi.Response{
		"POST /bundles":           answer(201, `{"digest":"`+digest+`"}`),
		"PUT /blueprints/notes/1": answer(409, `{"error":"notes 1 is already published"}`),
		"GET /blueprints/notes":   answer(200, `{"versions":[{"version":"1","bundle":"bbbb"}]}`),
	}})
	if c := published(bp); c == nil || c.Status != metav1.ConditionFalse || c.Reason != "Conflict" {
		t.Fatalf("condition %+v", c)
	}
}

func TestBlueprintRetriesWhileFleetIsDown(t *testing.T) {
	bp, res := publishBlueprint(t, &fakeKernel{err: errors.New("fleet not ready")})
	if c := published(bp); c == nil || c.Reason != "FleetUnavailable" || res.RequeueAfter == 0 {
		t.Fatalf("condition %+v requeue %v", c, res.RequeueAfter)
	}
}

func TestWorkspaceSyncs(t *testing.T) {
	ws := &kodov1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: "team", Namespace: "kodo", Generation: 1},
		Spec:       kodov1.WorkspaceSpec{Fleet: "kodo", Quota: 5},
	}
	c := fake.NewClientBuilder().WithScheme(testScheme(t)).WithObjects(ws).WithStatusSubresource(&kodov1.Workspace{}).Build()
	kernel := &fakeKernel{answers: map[string]kernelapi.Response{
		"PUT /workspaces/team": answer(200, `{"name":"team","quota":5,"cells":2}`),
	}}
	r := &WorkspaceReconciler{Client: c, Kernel: kernel}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(ws)}); err != nil {
		t.Fatal(err)
	}
	var got kodov1.Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(ws), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Cells != 2 || meta.FindStatusCondition(got.Status.Conditions, ConditionSynced).Status != metav1.ConditionTrue {
		t.Fatalf("status %+v", got.Status)
	}
}
