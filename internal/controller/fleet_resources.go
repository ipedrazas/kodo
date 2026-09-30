package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
)

const (
	publicPort   = 8080
	internalPort = 8081
	fleetLabel   = "kodo.dev/fleet"
	roleLabel    = "kodo.dev/role"

	// celld stops a node within CELLD_SHUTDOWN_TOTAL_MS (40 s by default);
	// the grace period must cover it or Kubernetes kills the node mid-handoff.
	terminationGraceSeconds = 60
)

// Names of the objects a Fleet owns.
func peersServiceName(f *kodov1.Fleet) string  { return f.Name + "-peers" }
func networkPolicyName(f *kodov1.Fleet) string { return f.Name + "-internal" }

// kernelJobName changes with the kernel image, so each image is deployed by
// its own Job.
func kernelJobName(f *kodov1.Fleet) string {
	sum := sha256.Sum256([]byte(f.Spec.Kernel))
	return f.Name + "-kernel-" + hex.EncodeToString(sum[:])[:10]
}

func nodeLabels(f *kodov1.Fleet) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       "celld",
		"app.kubernetes.io/managed-by": "kodo-operator",
		fleetLabel:                     f.Name,
		roleLabel:                      "node",
	}
}

func nodeSelector(f *kodov1.Fleet) map[string]string {
	return map[string]string{fleetLabel: f.Name, roleLabel: "node"}
}

// bucketEnv is the bucket configuration shared by the nodes and the kernel
// deploy Job.
func bucketEnv(f *kodov1.Fleet) []corev1.EnvVar {
	secret := func(key string) corev1.EnvVar {
		return corev1.EnvVar{Name: key, ValueFrom: &corev1.EnvVarSource{
			SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: f.Spec.Bucket.CredentialsSecret},
				Key:                  key,
			},
		}}
	}
	env := []corev1.EnvVar{
		{Name: "CELLD_BUCKET", Value: "s3://" + f.Spec.Bucket.Name},
		secret("AWS_ACCESS_KEY_ID"),
		secret("AWS_SECRET_ACCESS_KEY"),
	}
	if f.Spec.Bucket.Endpoint != "" {
		env = append(env, corev1.EnvVar{Name: "S3_ENDPOINT", Value: f.Spec.Bucket.Endpoint})
	}
	if f.Spec.Bucket.Region != "" {
		env = append(env, corev1.EnvVar{Name: "AWS_REGION", Value: f.Spec.Bucket.Region})
	}
	return env
}

func restrictedSecurityContext() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
}

// desiredStatefulSet is the node StatefulSet for the Fleet. The image and
// replica count are managed separately by the upgrade logic, so this sets
// them only for a new StatefulSet.
func desiredStatefulSet(f *kodov1.Fleet) *appsv1.StatefulSet {
	storage := f.Spec.StorageSize
	if storage.IsZero() {
		storage = resource.MustParse("2Gi")
	}
	idle := f.Spec.IdleEvictSeconds
	if idle == 0 {
		idle = 30
	}
	env := append([]corev1.EnvVar{
		{Name: "POD_IP", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.podIP"}}},
		{Name: "CELLD_WATCH", Value: "/var/lib/celld/state"},
		{Name: "CELLD_IDLE_EVICT_S", Value: strconv.Itoa(int(idle))},
	}, bucketEnv(f)...)

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: f.Name, Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec: appsv1.StatefulSetSpec{
			ServiceName:         peersServiceName(f),
			Replicas:            ptr.To(replicas(f)),
			PodManagementPolicy: appsv1.ParallelPodManagement,
			Selector:            &metav1.LabelSelector{MatchLabels: nodeSelector(f)},
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				// The volumes are caches of the bucket.
				WhenDeleted: appsv1.DeletePersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: nodeLabels(f)},
				Spec: corev1.PodSpec{
					RuntimeClassName:              f.Spec.RuntimeClassName,
					AutomountServiceAccountToken:  ptr.To(false),
					TerminationGracePeriodSeconds: ptr.To[int64](terminationGraceSeconds),
					TopologySpreadConstraints: []corev1.TopologySpreadConstraint{{
						MaxSkew:           1,
						TopologyKey:       "kubernetes.io/hostname",
						WhenUnsatisfiable: corev1.ScheduleAnyway,
						LabelSelector:     &metav1.LabelSelector{MatchLabels: nodeSelector(f)},
					}},
					Containers: []corev1.Container{{
						Name:  "celld",
						Image: f.Spec.Celld,
						Args: []string{
							"--listen", fmt.Sprintf("0.0.0.0:%d", publicPort),
							"--internal-listen", fmt.Sprintf("$(POD_IP):%d", internalPort),
							"--advertise", fmt.Sprintf("$(POD_IP):%d", internalPort),
						},
						Env: env,
						Ports: []corev1.ContainerPort{
							{Name: "http", ContainerPort: publicPort},
							{Name: "internal", ContainerPort: internalPort},
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
								Path: "/.well-known/celld/health",
								Port: intstr.FromString("http"),
							}},
							PeriodSeconds: 2,
						},
						Resources:       f.Spec.Resources,
						SecurityContext: restrictedSecurityContext(),
						VolumeMounts:    []corev1.VolumeMount{{Name: "state", MountPath: "/var/lib/celld"}},
					}},
				},
			},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{{
				ObjectMeta: metav1.ObjectMeta{Name: "state"},
				Spec: corev1.PersistentVolumeClaimSpec{
					AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
					StorageClassName: f.Spec.StorageClassName,
					Resources: corev1.VolumeResourceRequirements{
						Requests: corev1.ResourceList{corev1.ResourceStorage: storage},
					},
				},
			}},
		},
	}
}

func replicas(f *kodov1.Fleet) int32 {
	if f.Spec.Replicas == 0 {
		return 3
	}
	return f.Spec.Replicas
}

// desiredService is the public Service: the kernel's HTTP listener.
func desiredService(f *kodov1.Fleet) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: f.Name, Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec: corev1.ServiceSpec{
			Selector: nodeSelector(f),
			Ports: []corev1.ServicePort{{
				Name: "http", Port: 80, TargetPort: intstr.FromString("http"),
			}},
		},
	}
}

// desiredPeersService gives the nodes stable names; they find each other
// through the bucket.
func desiredPeersService(f *kodov1.Fleet) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: peersServiceName(f), Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec: corev1.ServiceSpec{
			ClusterIP: corev1.ClusterIPNone,
			Selector:  nodeSelector(f),
			Ports: []corev1.ServicePort{{
				Name: "internal", Port: internalPort, TargetPort: intstr.FromString("internal"),
			}},
		},
	}
}

// desiredNetworkPolicy admits the internal listener, which serves the peer
// protocol and an unauthenticated operator API, only from the fleet's own
// nodes. The public listener stays open.
func desiredNetworkPolicy(f *kodov1.Fleet) *networkingv1.NetworkPolicy {
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: networkPolicyName(f), Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: nodeSelector(f)},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{
				{
					Ports: []networkingv1.NetworkPolicyPort{{Port: ptr.To(intstr.FromInt32(publicPort))}},
				},
				{
					Ports: []networkingv1.NetworkPolicyPort{{Port: ptr.To(intstr.FromInt32(internalPort))}},
					From: []networkingv1.NetworkPolicyPeer{{
						PodSelector: &metav1.LabelSelector{MatchLabels: nodeSelector(f)},
					}},
				},
			},
		},
	}
}

// desiredKernelJob deploys the Fleet's kernel image to its bucket.
func desiredKernelJob(f *kodov1.Fleet) *batchv1.Job {
	labels := map[string]string{
		"app.kubernetes.io/name":       "kodo-kernel-deploy",
		"app.kubernetes.io/managed-by": "kodo-operator",
		fleetLabel:                     f.Name,
		roleLabel:                      "kernel-deploy",
	}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: kernelJobName(f), Namespace: f.Namespace, Labels: labels},
		Spec: batchv1.JobSpec{
			BackoffLimit: ptr.To[int32](4),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyOnFailure,
					AutomountServiceAccountToken: ptr.To(false),
					Containers: []corev1.Container{{
						Name:            "deploy",
						Image:           f.Spec.Kernel,
						Env:             bucketEnv(f),
						SecurityContext: restrictedSecurityContext(),
					}},
				},
			},
		},
	}
}
