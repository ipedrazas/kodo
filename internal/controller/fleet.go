// Package controller reconciles the kodo.dev resources.
package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
)

// Condition types on a Fleet.
const (
	ConditionReady          = "Ready"
	ConditionKernelDeployed = "KernelDeployed"
	ConditionUpgrading      = "Upgrading"
)

// FleetReconciler runs a Fleet's nodes and deploys its kernel.
type FleetReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=kodo.dev,resources=fleets,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=kodo.dev,resources=fleets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete

func (r *FleetReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var fleet kodov1.Fleet
	if err := r.Get(ctx, req.NamespacedName, &fleet); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	for _, obj := range []client.Object{desiredService(&fleet), desiredPeersService(&fleet), desiredNetworkPolicy(&fleet)} {
		if err := r.apply(ctx, &fleet, obj); err != nil {
			return ctrl.Result{}, err
		}
	}

	if err := r.ensureAdminToken(ctx, &fleet); err != nil {
		return ctrl.Result{}, err
	}
	sts, requeue, err := r.reconcileNodes(ctx, &fleet)
	if err != nil {
		return ctrl.Result{}, err
	}
	job, err := r.reconcileKernel(ctx, &fleet)
	if err != nil {
		return ctrl.Result{}, err
	}

	if err := r.updateStatus(ctx, &fleet, sts, job); err != nil {
		return ctrl.Result{}, err
	}
	if requeue > 0 {
		return ctrl.Result{RequeueAfter: requeue}, nil
	}
	return ctrl.Result{}, nil
}

// apply creates or updates an owned object's spec to match obj.
func (r *FleetReconciler) apply(ctx context.Context, fleet *kodov1.Fleet, obj client.Object) error {
	desired := obj.DeepCopyObject().(client.Object)
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		switch o := obj.(type) {
		case *corev1.Service:
			d := desired.(*corev1.Service)
			o.Labels = d.Labels
			o.Spec.Selector = d.Spec.Selector
			o.Spec.Ports = d.Spec.Ports
			if o.Spec.ClusterIP == "" {
				o.Spec.ClusterIP = d.Spec.ClusterIP
			}
		case *networkingv1.NetworkPolicy:
			d := desired.(*networkingv1.NetworkPolicy)
			o.Labels = d.Labels
			o.Spec = d.Spec
		}
		return controllerutil.SetControllerReference(fleet, obj, r.Scheme)
	})
	return err
}

// ensureAdminToken creates the Secret with the token the operator uses on the
// kernel API, once; the kernel deploy Job gives the kernel its hash.
func (r *FleetReconciler) ensureAdminToken(ctx context.Context, fleet *kodov1.Fleet) error {
	key := client.ObjectKey{Namespace: fleet.Namespace, Name: AdminTokenSecretName(fleet)}
	var secret corev1.Secret
	err := r.Get(ctx, key, &secret)
	if !apierrors.IsNotFound(err) {
		return err
	}
	token := make([]byte, 24)
	if _, err := rand.Read(token); err != nil {
		return err
	}
	secret = corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: key.Namespace, Labels: nodeLabels(fleet)},
		Data:       map[string][]byte{"token": []byte(hex.EncodeToString(token))},
	}
	if err := controllerutil.SetControllerReference(fleet, &secret, r.Scheme); err != nil {
		return err
	}
	return r.Create(ctx, &secret)
}

// nodeStep is what the celld upgrade needs next.
type nodeStep int

const (
	// Nodes run the wanted image: keep the replica count at the wanted size.
	stepSteady nodeStep = iota
	// Nodes run another image: scale to zero first, because mixed celld
	// versions cannot share a fleet.
	stepStop
	// Scaled to zero, but pods are still shutting down.
	stepWaitStopped
	// Every old node is gone: start the new image.
	stepStart
)

func nextNodeStep(runningImage string, replicas int32, pods int, wantedImage string) nodeStep {
	switch {
	case runningImage == wantedImage:
		return stepSteady
	case replicas > 0:
		return stepStop
	case pods > 0:
		return stepWaitStopped
	default:
		return stepStart
	}
}

// reconcileNodes creates the node StatefulSet or brings it in line with the
// spec, stopping every node before a celld image change.
func (r *FleetReconciler) reconcileNodes(ctx context.Context, fleet *kodov1.Fleet) (*appsv1.StatefulSet, time.Duration, error) {
	logger := log.FromContext(ctx)
	desired := desiredStatefulSet(fleet)
	var sts appsv1.StatefulSet
	err := r.Get(ctx, client.ObjectKeyFromObject(desired), &sts)
	if apierrors.IsNotFound(err) {
		if err := controllerutil.SetControllerReference(fleet, desired, r.Scheme); err != nil {
			return nil, 0, err
		}
		return desired, 0, r.Create(ctx, desired)
	}
	if err != nil {
		return nil, 0, err
	}

	running := sts.Spec.Template.Spec.Containers[0].Image
	var pods corev1.PodList
	if err := r.List(ctx, &pods, client.InNamespace(fleet.Namespace), client.MatchingLabels(nodeSelector(fleet))); err != nil {
		return nil, 0, err
	}

	image, count, requeue := running, replicas(fleet), time.Duration(0)
	switch step := nextNodeStep(running, ptr.Deref(sts.Spec.Replicas, 0), len(pods.Items), fleet.Spec.Celld); step {
	case stepStop:
		logger.Info("stopping every node before the celld upgrade", "from", running, "to", fleet.Spec.Celld)
		count, requeue = 0, 5*time.Second
	case stepWaitStopped:
		count, requeue = 0, 5*time.Second
	case stepStart:
		logger.Info("starting nodes on the new celld image", "image", fleet.Spec.Celld)
		image = fleet.Spec.Celld
	}

	// Only the mutable parts of the spec; the selector, service name and
	// volume templates are fixed at creation.
	sts.Labels = desired.Labels
	sts.Spec.Replicas = ptr.To(count)
	sts.Spec.PersistentVolumeClaimRetentionPolicy = desired.Spec.PersistentVolumeClaimRetentionPolicy
	sts.Spec.Template = desired.Spec.Template
	sts.Spec.Template.Spec.Containers[0].Image = image
	if err := r.Update(ctx, &sts); err != nil {
		return nil, 0, err
	}
	return &sts, requeue, nil
}

// reconcileKernel runs the deploy Job for the Fleet's kernel image, and
// removes Jobs for earlier images.
func (r *FleetReconciler) reconcileKernel(ctx context.Context, fleet *kodov1.Fleet) (*batchv1.Job, error) {
	desired := desiredKernelJob(fleet)
	var jobs batchv1.JobList
	if err := r.List(ctx, &jobs, client.InNamespace(fleet.Namespace),
		client.MatchingLabels{fleetLabel: fleet.Name, roleLabel: "kernel-deploy"}); err != nil {
		return nil, err
	}
	var current *batchv1.Job
	for i := range jobs.Items {
		job := &jobs.Items[i]
		if job.Name == desired.Name {
			current = job
			continue
		}
		if err := r.Delete(ctx, job, client.PropagationPolicy(metav1.DeletePropagationBackground)); client.IgnoreNotFound(err) != nil {
			return nil, err
		}
	}
	if current != nil {
		return current, nil
	}
	if err := controllerutil.SetControllerReference(fleet, desired, r.Scheme); err != nil {
		return nil, err
	}
	return desired, r.Create(ctx, desired)
}

func jobFinished(job *batchv1.Job) (done bool, failed bool) {
	for _, c := range job.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			return true, false
		case batchv1.JobFailed:
			return true, true
		}
	}
	return false, false
}

func (r *FleetReconciler) updateStatus(ctx context.Context, fleet *kodov1.Fleet, sts *appsv1.StatefulSet, job *batchv1.Job) error {
	status := fleet.Status.DeepCopy()
	status.ObservedGeneration = fleet.Generation
	status.ReadyReplicas = sts.Status.ReadyReplicas
	running := sts.Spec.Template.Spec.Containers[0].Image
	set := func(t string, ok bool, reason, message string) {
		s := metav1.ConditionFalse
		if ok {
			s = metav1.ConditionTrue
		}
		meta.SetStatusCondition(&status.Conditions, metav1.Condition{
			Type: t, Status: s, Reason: reason, Message: message, ObservedGeneration: fleet.Generation,
		})
	}

	upgrading := running != fleet.Spec.Celld
	if upgrading {
		set(ConditionUpgrading, true, "Restarting", fmt.Sprintf("stopping every node to move from %s to %s", running, fleet.Spec.Celld))
	} else {
		status.Celld = running
		set(ConditionUpgrading, false, "Current", "every node runs "+running)
	}

	switch done, failed := jobFinished(job); {
	case failed:
		set(ConditionKernelDeployed, false, "DeployFailed", fmt.Sprintf("job %s failed; see its logs", job.Name))
	case done:
		status.Kernel = fleet.Spec.Kernel
		set(ConditionKernelDeployed, true, "Deployed", fleet.Spec.Kernel)
	default:
		set(ConditionKernelDeployed, false, "Deploying", "job "+job.Name+" is running")
	}

	ready := !upgrading && status.Kernel == fleet.Spec.Kernel && status.ReadyReplicas == replicas(fleet)
	set(ConditionReady, ready, map[bool]string{true: "Ready", false: "NotReady"}[ready],
		fmt.Sprintf("%d of %d nodes ready", status.ReadyReplicas, replicas(fleet)))

	fleet.Status = *status
	return r.Status().Update(ctx, fleet)
}

func (r *FleetReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kodov1.Fleet{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&batchv1.Job{}).
		Named("fleet").
		Complete(r)
}
