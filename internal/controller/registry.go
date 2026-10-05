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
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

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

// BlueprintFinalizer withdraws a deleted Blueprint's version from its
// Fleet's catalog, so no new cell can use it; cells already on it keep
// running.
const BlueprintFinalizer = "kodo.dev/withdraw"

// BlueprintReconciler publishes each Blueprint resource to its Fleet's
// catalog, as `POST /api/bundles` and `PUT /api/blueprints/...` would, and
// withdraws it when the resource is deleted.
type BlueprintReconciler struct {
	ctrl.Client
	Kernel Kernel
}

// +kubebuilder:rbac:groups=kodo.dev,resources=blueprints,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=kodo.dev,resources=blueprints/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kodo.dev,resources=blueprints/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services/proxy,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create

func (r *BlueprintReconciler) Reconcile(ctx context.Context, req ctrlmgr.Request) (ctrlmgr.Result, error) {
	var bp kodov1.Blueprint
	if err := r.Get(ctx, req.NamespacedName, &bp); err != nil {
		return ctrlmgr.Result{}, ctrl.IgnoreNotFound(err)
	}
	if !bp.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, &bp)
	}
	if controllerutil.AddFinalizer(&bp, BlueprintFinalizer) {
		if err := r.Update(ctx, &bp); err != nil {
			return ctrlmgr.Result{}, err
		}
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
		existing, status, err := r.publishedVersion(ctx, target, bp)
		if err != nil {
			return uploaded.Digest, false, "FleetUnavailable", err.Error(), nil
		}
		if existing != uploaded.Digest {
			return uploaded.Digest, false, "Conflict",
				fmt.Sprintf("%s %s is already published with bundle %s; versions are immutable", bp.Spec.Blueprint, bp.Spec.Version, existing), nil
		}
		// The same version applied again after its resource was deleted,
		// which withdrew it: restore it.
		if status == "withdrawn" {
			res, err := call(http.MethodPost, path+"/restore", nil)
			if err != nil {
				return uploaded.Digest, false, "FleetUnavailable", err.Error(), nil
			}
			if !res.OK() {
				return uploaded.Digest, false, "Rejected", res.Error(), nil
			}
			return uploaded.Digest, true, "Published", fmt.Sprintf("%s %s restored", bp.Spec.Blueprint, bp.Spec.Version), nil
		}
		return uploaded.Digest, true, "Published", fmt.Sprintf("%s %s published", bp.Spec.Blueprint, bp.Spec.Version), nil
	default:
		return uploaded.Digest, false, "Rejected", res.Error(), nil
	}
}

// publishedVersion is the bundle and status ("published", "withdrawn") of
// the Blueprint's version in the catalog.
func (r *BlueprintReconciler) publishedVersion(ctx context.Context, target kernelapi.Target, bp *kodov1.Blueprint) (bundle, status string, err error) {
	res, err := r.Kernel.Do(ctx, target, http.MethodGet, "/blueprints/"+bp.Spec.Blueprint, nil)
	if err != nil {
		return "", "", err
	}
	var body struct {
		Versions []struct {
			Version string `json:"version"`
			Bundle  string `json:"bundle"`
			Status  string `json:"status"`
		} `json:"versions"`
	}
	if err := res.Decode(&body); err != nil {
		return "", "", fmt.Errorf("reading %s: %w", bp.Spec.Blueprint, err)
	}
	for _, v := range body.Versions {
		if v.Version == bp.Spec.Version {
			return v.Bundle, v.Status, nil
		}
	}
	return "", "", fmt.Errorf("%s %s is not listed", bp.Spec.Blueprint, bp.Spec.Version)
}

// finalize withdraws a deleted Blueprint's version, then lets the resource
// go. Nothing is withdrawn for a version this resource did not publish (it
// failed, or conflicted with another bundle) or that another resource still
// publishes, and nothing waits on a Fleet that is gone or going.
func (r *BlueprintReconciler) finalize(ctx context.Context, bp *kodov1.Blueprint) (ctrlmgr.Result, error) {
	if !controllerutil.ContainsFinalizer(bp, BlueprintFinalizer) {
		return ctrlmgr.Result{}, nil
	}
	withdraw, err := r.shouldWithdraw(ctx, bp)
	if err != nil {
		return ctrlmgr.Result{}, err
	}
	if withdraw {
		target, err := kernelTarget(ctx, r.Client, bp.Namespace, bp.Spec.Fleet)
		if err != nil {
			return ctrlmgr.Result{RequeueAfter: retryAfter}, nil
		}
		path := fmt.Sprintf("/blueprints/%s/%s/withdraw", bp.Spec.Blueprint, bp.Spec.Version)
		res, err := r.Kernel.Do(ctx, target, http.MethodPost, path, nil)
		if err != nil {
			return ctrlmgr.Result{RequeueAfter: retryAfter}, nil
		}
		// 404: the catalog no longer has it; 409: already withdrawn.
		if !res.OK() && res.Status != http.StatusNotFound && res.Status != http.StatusConflict {
			return ctrlmgr.Result{}, fmt.Errorf("withdrawing %s %s: %d %s", bp.Spec.Blueprint, bp.Spec.Version, res.Status, res.Error())
		}
	}
	controllerutil.RemoveFinalizer(bp, BlueprintFinalizer)
	return ctrlmgr.Result{}, r.Update(ctx, bp)
}

func (r *BlueprintReconciler) shouldWithdraw(ctx context.Context, bp *kodov1.Blueprint) (bool, error) {
	if c := meta.FindStatusCondition(bp.Status.Conditions, ConditionPublished); c == nil || c.Status != metav1.ConditionTrue {
		return false, nil
	}
	var fleet kodov1.Fleet
	if err := r.Get(ctx, ctrl.ObjectKey{Namespace: bp.Namespace, Name: bp.Spec.Fleet}, &fleet); err != nil {
		return false, ctrl.IgnoreNotFound(err)
	}
	if !fleet.DeletionTimestamp.IsZero() {
		return false, nil
	}
	var all kodov1.BlueprintList
	if err := r.List(ctx, &all, ctrl.InNamespace(bp.Namespace)); err != nil {
		return false, err
	}
	for _, other := range all.Items {
		if other.Name != bp.Name && other.DeletionTimestamp.IsZero() &&
			other.Spec.Fleet == bp.Spec.Fleet && other.Spec.Blueprint == bp.Spec.Blueprint && other.Spec.Version == bp.Spec.Version &&
			meta.IsStatusConditionTrue(other.Status.Conditions, ConditionPublished) {
			return false, nil
		}
	}
	return true, nil
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
