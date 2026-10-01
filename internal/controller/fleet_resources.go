package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

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

	// A stopping node keeps serving for this long before celld starts to
	// drain, so Services stop routing to it first; otherwise requests that
	// race the endpoint update get celld's 503.
	preStopSeconds = 5

	// celld stops a node within CELLD_SHUTDOWN_TOTAL_MS (40 s by default);
	// the grace period must cover it, after the pre-stop wait, or Kubernetes
	// kills the node mid-handoff.
	terminationGraceSeconds = preStopSeconds + 60
)

// Names of the objects a Fleet owns.
func peersServiceName(f *kodov1.Fleet) string        { return f.Name + "-peers" }
func networkPolicyName(f *kodov1.Fleet) string       { return f.Name + "-internal" }
func egressPolicyName(f *kodov1.Fleet) string        { return f.Name + "-egress" }
func gatekeeperKeySecretName(f *kodov1.Fleet) string { return f.Name + "-gatekeeper-key" }

// The Gatekeeper's internal port, which kernels call, and the label its pods
// carry.
const (
	gatekeeperPort       = 8081
	gatekeeperEgressPort = 8082
	gatekeeperName       = "kodo-gatekeeper"
)

// gatekeeper is the Fleet's Gatekeeper reference with defaults filled in.
func gatekeeper(f *kodov1.Fleet) *kodov1.GatekeeperRef {
	if f.Spec.Gatekeeper == nil {
		return nil
	}
	g := *f.Spec.Gatekeeper
	if g.Namespace == "" {
		g.Namespace = "kodo-system"
	}
	if g.Service == "" {
		g.Service = gatekeeperName
	}
	if g.TrustSecret == "" {
		g.TrustSecret = "kodo-gatekeeper-fleets"
	}
	return &g
}

// fleetID is how the Gatekeeper knows the fleet, and trustKey the name of
// its key in the Gatekeeper's trust Secret.
func fleetID(f *kodov1.Fleet) string  { return f.Namespace + "/" + f.Name }
func trustKey(f *kodov1.Fleet) string { return f.Namespace + "." + f.Name }

func gatekeeperURL(g *kodov1.GatekeeperRef) string {
	return fmt.Sprintf("http://%s.%s.svc:%d", g.Service, g.Namespace, gatekeeperPort)
}

// egressProxy is the Gatekeeper's egress proxy, when the Fleet sends its
// nodes' HTTPS traffic through it; "" otherwise.
func egressProxy(f *kodov1.Fleet) string {
	g := gatekeeper(f)
	if g == nil || f.Spec.Egress == nil || !f.Spec.Egress.Proxy {
		return ""
	}
	return fmt.Sprintf("http://%s.%s.svc:%d", g.Service, g.Namespace, gatekeeperEgressPort)
}

// AdminTokenSecretName is the Secret holding the token the operator uses on
// the Fleet's kernel API, under the key "token".
func AdminTokenSecretName(f *kodov1.Fleet) string { return f.Name + "-admin-token" }

// kernelJobName changes with the kernel image and identity settings, so each
// combination is deployed by its own Job.
func kernelJobName(f *kodov1.Fleet) string {
	key := f.Spec.Kernel
	if a := f.Spec.Auth; a != nil {
		key += "|" + a.Issuer + "|" + a.Audience + "|" + a.JWKSURL
	}
	if g := gatekeeper(f); g != nil {
		key += "|" + gatekeeperURL(g)
	}
	sum := sha256.Sum256([]byte(key))
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

// kernelAuthEnv is what the kernel image's deploy script reads for identity.
func kernelAuthEnv(f *kodov1.Fleet) []corev1.EnvVar {
	env := []corev1.EnvVar{{Name: "KERNEL_ADMIN_TOKEN", ValueFrom: &corev1.EnvVarSource{
		SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: AdminTokenSecretName(f)},
			Key:                  "token",
		},
	}}}
	if a := f.Spec.Auth; a != nil {
		jwks := a.JWKSURL
		if jwks == "" {
			jwks = strings.TrimSuffix(a.Issuer, "/") + "/keys"
		}
		env = append(env,
			corev1.EnvVar{Name: "OIDC_ISSUER", Value: a.Issuer},
			corev1.EnvVar{Name: "OIDC_AUDIENCE", Value: a.Audience},
			corev1.EnvVar{Name: "OIDC_JWKS_URL", Value: jwks},
		)
	}
	if g := gatekeeper(f); g != nil {
		env = append(env,
			corev1.EnvVar{Name: "GATEKEEPER_URL", Value: gatekeeperURL(g)},
			corev1.EnvVar{Name: "FLEET_ID", Value: fleetID(f)},
			corev1.EnvVar{Name: "GATEKEEPER_KEY", ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: gatekeeperKeySecretName(f)},
					Key:                  "key",
				},
			}},
		)
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
	if proxy := egressProxy(f); proxy != "" {
		// HTTPS only: peers, the Gatekeeper and in-cluster services are
		// plain HTTP and go direct.
		env = append(env,
			corev1.EnvVar{Name: "HTTPS_PROXY", Value: proxy},
			corev1.EnvVar{Name: "NO_PROXY", Value: "localhost,127.0.0.1,.svc,.cluster.local"},
		)
	}

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
						Lifecycle: &corev1.Lifecycle{
							PreStop: &corev1.LifecycleHandler{Sleep: &corev1.SleepAction{Seconds: preStopSeconds}},
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

// desiredEgressPolicy denies the nodes every outbound connection except DNS,
// the fleet's own nodes (the peer protocol), the Gatekeeper's internal port
// and egress proxy, and the Fleet's extra rules. Nil when the Fleet sets no
// egress.
func desiredEgressPolicy(f *kodov1.Fleet) *networkingv1.NetworkPolicy {
	if f.Spec.Egress == nil {
		return nil
	}
	udp, tcp := corev1.ProtocolUDP, corev1.ProtocolTCP
	rules := []networkingv1.NetworkPolicyEgressRule{
		{
			To: []networkingv1.NetworkPolicyPeer{{
				NamespaceSelector: &metav1.LabelSelector{},
				PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"k8s-app": "kube-dns"}},
			}},
			Ports: []networkingv1.NetworkPolicyPort{
				{Protocol: &udp, Port: ptr.To(intstr.FromInt32(53))},
				{Protocol: &tcp, Port: ptr.To(intstr.FromInt32(53))},
			},
		},
		{To: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: nodeSelector(f)}}}},
	}
	if g := gatekeeper(f); g != nil {
		rules = append(rules, networkingv1.NetworkPolicyEgressRule{
			To: []networkingv1.NetworkPolicyPeer{{
				NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": g.Namespace}},
				PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": gatekeeperName}},
			}},
			Ports: []networkingv1.NetworkPolicyPort{
				{Protocol: &tcp, Port: ptr.To(intstr.FromInt32(gatekeeperPort))},
				{Protocol: &tcp, Port: ptr.To(intstr.FromInt32(gatekeeperEgressPort))},
			},
		})
	}
	rules = append(rules, f.Spec.Egress.Allow...)
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: egressPolicyName(f), Namespace: f.Namespace, Labels: nodeLabels(f)},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: nodeSelector(f)},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress:      rules,
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
						Env:             append(bucketEnv(f), kernelAuthEnv(f)...),
						SecurityContext: restrictedSecurityContext(),
					}},
				},
			},
		},
	}
}
