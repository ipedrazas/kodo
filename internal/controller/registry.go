package controller

import (
	"context"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	ctrlmgr "sigs.k8s.io/controller-runtime"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
	"github.com/ipedrazas/kodo/internal/kernelapi"
)

// Condition types on Blueprints and Workspaces.
const (
	ConditionPublished = "Published"
	ConditionSynced    = "Synced"
)

// While a fleet is not answering, registry resources are retried this often.
const retryAfter = 10 * time.Second

// Kernel is the part of kernelapi.Client the registry reconcilers use.
type Kernel interface {
	Do(ctx context.Context, t kernelapi.Target, method, path string, body any) (kernelapi.Response, error)
}

// kernelTarget is the kernel API of the named Fleet, with its admin token.
func kernelTarget(ctx context.Context, c ctrl.Client, namespace, fleet string) (kernelapi.Target, error) {
	var secret corev1.Secret
	name := AdminTokenSecretName(&kodov1.Fleet{ObjectMeta: metav1.ObjectMeta{Name: fleet}})
	if err := c.Get(ctx, ctrl.ObjectKey{Namespace: namespace, Name: name}, &secret); err != nil {
		return kernelapi.Target{}, fmt.Errorf("admin token for fleet %s: %w", fleet, err)
	}
	return kernelapi.Target{Namespace: namespace, Service: fleet, AdminToken: string(secret.Data["token"])}, nil
}

// BlueprintReconciler publishes each Blueprint resource to its Fleet's
// catalog, as `POST /api/bundles` and `PUT /api/blueprints/...` would.
type BlueprintReconciler struct {
	ctrl.Client
	Kernel Kernel
}

// +kubebuilder:rbac:groups=kodo.dev,resources=blueprints,verbs=get;list;watch
// +kubebuilder:rbac:groups=kodo.dev,resources=blueprints/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services/proxy,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create

func (r *BlueprintReconciler) Reconcile(ctx context.Context, req ctrlmgr.Request) (ctrlmgr.Result, error) {
	var bp kodov1.Blueprint
	if err := r.Get(ctx, req.NamespacedName, &bp); err != nil {
		return ctrlmgr.Result{}, ctrl.IgnoreNotFound(err)
	}
	if c := meta.FindStatusCondition(bp.Status.Conditions, ConditionPublished); c != nil &&
		c.Status == metav1.ConditionTrue && c.ObservedGeneration == bp.Generation {
		return ctrlmgr.Result{}, nil
	}

	digest, published, reason, message, err := r.publish(ctx, &bp)
	if err != nil {
		return ctrlmgr.Result{}, err
	}
	bp.Status.Digest = digest
	setCondition(&bp.Status.Conditions, bp.Generation, ConditionPublished, published, reason, message)
	if err := r.Status().Update(ctx, &bp); err != nil {
		return ctrlmgr.Result{}, err
	}
	if !published && reason == "FleetUnavailable" {
		return ctrlmgr.Result{RequeueAfter: retryAfter}, nil
	}
	return ctrlmgr.Result{}, nil
}

func (r *BlueprintReconciler) publish(ctx context.Context, bp *kodov1.Blueprint) (digest string, ok bool, reason, message string, err error) {
	var cm corev1.ConfigMap
	if err := r.Get(ctx, ctrl.ObjectKey{Namespace: bp.Namespace, Name: bp.Spec.Source.Name}, &cm); err != nil {
		return "", false, "SourceMissing", err.Error(), nil
	}
	source, found := cm.Data[bp.Spec.Source.Key]
	if !found {
		return "", false, "SourceMissing", fmt.Sprintf("ConfigMap %s has no key %s", cm.Name, bp.Spec.Source.Key), nil
	}

	target, err := kernelTarget(ctx, r.Client, bp.Namespace, bp.Spec.Fleet)
	if err != nil {
		return "", false, "FleetUnavailable", err.Error(), nil
	}
	call := func(method, path string, body any) (kernelapi.Response, error) {
		return r.Kernel.Do(ctx, target, method, path, body)
	}
	upload, err := call(http.MethodPost, "/bundles", []byte(source))
	if err != nil {
		return "", false, "FleetUnavailable", err.Error(), nil
	}
	if !upload.OK() {
		return "", false, "UploadFailed", upload.Error(), nil
	}
	var uploaded struct {
		Digest string `json:"digest"`
	}
	if err := upload.Decode(&uploaded); err != nil {
		return "", false, "UploadFailed", err.Error(), nil
	}

	path := fmt.Sprintf("/blueprints/%s/%s", bp.Spec.Blueprint, bp.Spec.Version)
	res, err := call(http.MethodPut, path, map[string]any{
		"bundle":       uploaded.Digest,
		"capabilities": nonNil(bp.Spec.Capabilities),
		"tier":         bp.Spec.Tier,
	})
	if err != nil {
		return uploaded.Digest, false, "FleetUnavailable", err.Error(), nil
	}
	switch {
	case res.OK():
		return uploaded.Digest, true, "Published", fmt.Sprintf("%s %s published", bp.Spec.Blueprint, bp.Spec.Version), nil
	case res.Status == http.StatusConflict:
		// Already published: fine if it is the same bundle, e.g. after an
		// operator restart; a conflict if the source changed.
		existing, err := r.publishedDigest(ctx, target, bp)
		if err != nil {
			return uploaded.Digest, false, "FleetUnavailable", err.Error(), nil
		}
		if existing == uploaded.Digest {
			return uploaded.Digest, true, "Published", fmt.Sprintf("%s %s published", bp.Spec.Blueprint, bp.Spec.Version), nil
		}
		return uploaded.Digest, false, "Conflict",
			fmt.Sprintf("%s %s is already published with bundle %s; versions are immutable", bp.Spec.Blueprint, bp.Spec.Version, existing), nil
	default:
		return uploaded.Digest, false, "Rejected", res.Error(), nil
	}
}

func (r *BlueprintReconciler) publishedDigest(ctx context.Context, target kernelapi.Target, bp *kodov1.Blueprint) (string, error) {
	res, err := r.Kernel.Do(ctx, target, http.MethodGet, "/blueprints/"+bp.Spec.Blueprint, nil)
	if err != nil {
		return "", err
	}
	var body struct {
		Versions []struct {
			Version string `json:"version"`
			Bundle  string `json:"bundle"`
		} `json:"versions"`
	}
	if err := res.Decode(&body); err != nil {
		return "", fmt.Errorf("reading %s: %w", bp.Spec.Blueprint, err)
	}
	for _, v := range body.Versions {
		if v.Version == bp.Spec.Version {
			return v.Bundle, nil
		}
	}
	return "", fmt.Errorf("%s %s is not listed", bp.Spec.Blueprint, bp.Spec.Version)
}

func (r *BlueprintReconciler) SetupWithManager(mgr ctrlmgr.Manager) error {
	return ctrlmgr.NewControllerManagedBy(mgr).For(&kodov1.Blueprint{}).Named("blueprint").Complete(r)
}

// WorkspaceReconciler applies each Workspace resource to its Fleet, as
// `PUT /api/workspaces/:name` would, and reports its cell count.
type WorkspaceReconciler struct {
	ctrl.Client
	Kernel Kernel
}

// How often a Workspace's cell count is refreshed.
const workspaceRefresh = time.Minute

// +kubebuilder:rbac:groups=kodo.dev,resources=workspaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=kodo.dev,resources=workspaces/status,verbs=get;update;patch

func (r *WorkspaceReconciler) Reconcile(ctx context.Context, req ctrlmgr.Request) (ctrlmgr.Result, error) {
	var ws kodov1.Workspace
	if err := r.Get(ctx, req.NamespacedName, &ws); err != nil {
		return ctrlmgr.Result{}, ctrl.IgnoreNotFound(err)
	}
	requeue := workspaceRefresh
	res := kernelapi.Response{}
	target, err := kernelTarget(ctx, r.Client, ws.Namespace, ws.Spec.Fleet)
	if err == nil {
		res, err = r.Kernel.Do(ctx, target, http.MethodPut, "/workspaces/"+ws.Name, map[string]any{"quota": ws.Spec.Quota})
	}
	switch {
	case err != nil:
		setCondition(&ws.Status.Conditions, ws.Generation, ConditionSynced, false, "FleetUnavailable", err.Error())
		requeue = retryAfter
	case !res.OK():
		setCondition(&ws.Status.Conditions, ws.Generation, ConditionSynced, false, "Rejected", res.Error())
	default:
		var info struct {
			Cells int32 `json:"cells"`
		}
		if err := res.Decode(&info); err != nil {
			return ctrlmgr.Result{}, err
		}
		ws.Status.Cells = info.Cells
		setCondition(&ws.Status.Conditions, ws.Generation, ConditionSynced, true, "Synced",
			fmt.Sprintf("quota %d applied", ws.Spec.Quota))
	}
	if err := r.Status().Update(ctx, &ws); err != nil {
		return ctrlmgr.Result{}, err
	}
	return ctrlmgr.Result{RequeueAfter: requeue}, nil
}

func (r *WorkspaceReconciler) SetupWithManager(mgr ctrlmgr.Manager) error {
	return ctrlmgr.NewControllerManagedBy(mgr).For(&kodov1.Workspace{}).Named("workspace").Complete(r)
}

func setCondition(conditions *[]metav1.Condition, generation int64, t string, ok bool, reason, message string) {
	s := metav1.ConditionFalse
	if ok {
		s = metav1.ConditionTrue
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: t, Status: s, Reason: reason, Message: message, ObservedGeneration: generation,
	})
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
