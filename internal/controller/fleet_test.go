package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kodov1 "github.com/ipedrazas/kodo/api/v1alpha1"
)

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	if err := kodov1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return s
}

func testFleet() *kodov1.Fleet {
	return &kodov1.Fleet{
		ObjectMeta: metav1.ObjectMeta{Name: "kodo", Namespace: "kodo", Generation: 1},
		Spec: kodov1.FleetSpec{
			Celld:            "ghcr.io/denoland/celld:0.6.0",
			Kernel:           "ghcr.io/ipedrazas/kodo-kernel:1",
			Replicas:         3,
			RuntimeClassName: ptr.To("gvisor"),
			Bucket: kodov1.BucketSpec{
				Name: "kodo-dev", Endpoint: "https://t3.storage.dev", Region: "auto", CredentialsSecret: "bucket",
			},
		},
	}
}

func TestNextNodeStep(t *testing.T) {
	const oldImage, newImage = "celld:1", "celld:2"
	tests := []struct {
		name     string
		running  string
		replicas int32
		pods     int
		want     nodeStep
	}{
		{"same image", newImage, 3, 3, stepSteady},
		{"new image with nodes running", oldImage, 3, 3, stepStop},
		{"scaled to zero, pods still stopping", oldImage, 0, 2, stepWaitStopped},
		{"every old node gone", oldImage, 0, 0, stepStart},
	}
	for _, tt := range tests {
		if got := nextNodeStep(tt.running, tt.replicas, tt.pods, newImage); got != tt.want {
			t.Errorf("%s: got step %d, want %d", tt.name, got, tt.want)
		}
	}
}

func TestStatefulSet(t *testing.T) {
	sts := desiredStatefulSet(testFleet())
	pod := sts.Spec.Template.Spec
	preStop := pod.Containers[0].Lifecycle.PreStop.Sleep.Seconds
	if got := ptr.Deref(pod.TerminationGracePeriodSeconds, 0); got <= preStop+40 {
		t.Errorf("termination grace %d s does not cover a %d s pre-stop wait and celld's 40 s shutdown", got, preStop)
	}
	if ptr.Deref(pod.AutomountServiceAccountToken, true) {
		t.Error("nodes get a ServiceAccount token")
	}
	if ptr.Deref(pod.RuntimeClassName, "") != "gvisor" {
		t.Errorf("runtime class %v, want gvisor", pod.RuntimeClassName)
	}
	env := map[string]corev1.EnvVar{}
	for _, e := range pod.Containers[0].Env {
		env[e.Name] = e
	}
	if env["CELLD_BUCKET"].Value != "s3://kodo-dev" || env["S3_ENDPOINT"].Value != "https://t3.storage.dev" ||
		env["AWS_REGION"].Value != "auto" {
		t.Errorf("bucket env wrong: %v", env)
	}
	if ref := env["AWS_SECRET_ACCESS_KEY"].ValueFrom; ref == nil || ref.SecretKeyRef.Name != "bucket" {
		t.Error("credentials do not come from the bucket Secret")
	}
}

func TestNetworkPolicyConfinesInternalListener(t *testing.T) {
	np := desiredNetworkPolicy(testFleet())
	for _, rule := range np.Spec.Ingress {
		if rule.Ports[0].Port.IntValue() != internalPort {
			continue
		}
		if len(rule.From) != 1 || rule.From[0].PodSelector.MatchLabels[fleetLabel] != "kodo" {
			t.Errorf("internal port admits %v", rule.From)
		}
		return
	}
	t.Error("no rule for the internal port")
}

func TestKernelJobNameFollowsImage(t *testing.T) {
	a, b := testFleet(), testFleet()
	b.Spec.Kernel = "ghcr.io/ipedrazas/kodo-kernel:2"
	if kernelJobName(a) == kernelJobName(b) {
		t.Error("a new kernel image reuses the old Job")
	}
}

func reconcileFleet(t *testing.T, c client.Client, s *runtime.Scheme) {
	t.Helper()
	r := &FleetReconciler{Client: c, Scheme: s}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKey{Namespace: "kodo", Name: "kodo"}}); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileCreatesTheFleet(t *testing.T) {
	s := testScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(testFleet()).WithStatusSubresource(&kodov1.Fleet{}).Build()
	reconcileFleet(t, c, s)

	ctx := context.Background()
	key := client.ObjectKey{Namespace: "kodo", Name: "kodo"}
	for _, obj := range []client.Object{&appsv1.StatefulSet{}, &corev1.Service{}, &networkingv1.NetworkPolicy{}} {
		name := key
		if _, ok := obj.(*networkingv1.NetworkPolicy); ok {
			name.Name = "kodo-internal"
		}
		if err := c.Get(ctx, name, obj); err != nil {
			t.Errorf("%T not created: %v", obj, err)
		}
	}
	var jobs batchv1.JobList
	if err := c.List(ctx, &jobs); err != nil || len(jobs.Items) != 1 {
		t.Fatalf("want one kernel Job, got %d (%v)", len(jobs.Items), err)
	}
	if img := jobs.Items[0].Spec.Template.Spec.Containers[0].Image; img != "ghcr.io/ipedrazas/kodo-kernel:1" {
		t.Errorf("kernel Job runs %s", img)
	}

	var fleet kodov1.Fleet
	if err := c.Get(ctx, key, &fleet); err != nil {
		t.Fatal(err)
	}
	if c := meta.FindStatusCondition(fleet.Status.Conditions, ConditionKernelDeployed); c == nil || c.Reason != "Deploying" {
		t.Errorf("KernelDeployed condition: %+v", c)
	}
	var token corev1.Secret
	if err := c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo-admin-token"}, &token); err != nil || len(token.Data["token"]) < 32 {
		t.Errorf("admin token Secret: %v, %d bytes", err, len(token.Data["token"]))
	}
}

func TestKernelJobCarriesIdentitySettings(t *testing.T) {
	f := testFleet()
	f.Spec.Auth = &kodov1.AuthSpec{Issuer: "https://auth.example.com/", Audience: "kodo"}
	env := map[string]corev1.EnvVar{}
	for _, e := range desiredKernelJob(f).Spec.Template.Spec.Containers[0].Env {
		env[e.Name] = e
	}
	if env["OIDC_ISSUER"].Value != "https://auth.example.com/" || env["OIDC_AUDIENCE"].Value != "kodo" ||
		env["OIDC_JWKS_URL"].Value != "https://auth.example.com/keys" {
		t.Errorf("identity env: %v", env)
	}
	if ref := env["KERNEL_ADMIN_TOKEN"].ValueFrom; ref == nil || ref.SecretKeyRef.Name != "kodo-admin-token" {
		t.Error("admin token does not come from the Fleet's Secret")
	}
	if kernelJobName(f) == kernelJobName(testFleet()) {
		t.Error("changing identity settings reuses the old deploy Job")
	}
}

func TestCelldUpgradeStopsEveryNodeFirst(t *testing.T) {
	s := testScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(testFleet()).WithStatusSubresource(&kodov1.Fleet{}).Build()
	reconcileFleet(t, c, s)
	ctx := context.Background()
	key := client.ObjectKey{Namespace: "kodo", Name: "kodo"}

	// One node pod is still running the old version.
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "kodo-0", Namespace: "kodo", Labels: nodeSelector(testFleet())}}
	if err := c.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	var fleet kodov1.Fleet
	if err := c.Get(ctx, key, &fleet); err != nil {
		t.Fatal(err)
	}
	fleet.Spec.Celld = "ghcr.io/denoland/celld:0.7.0"
	if err := c.Update(ctx, &fleet); err != nil {
		t.Fatal(err)
	}

	sts := func() appsv1.StatefulSet {
		var sts appsv1.StatefulSet
		if err := c.Get(ctx, key, &sts); err != nil {
			t.Fatal(err)
		}
		return sts
	}

	reconcileFleet(t, c, s)
	if got := sts(); *got.Spec.Replicas != 0 || got.Spec.Template.Spec.Containers[0].Image != "ghcr.io/denoland/celld:0.6.0" {
		t.Fatalf("first step: replicas %d image %s, want 0 on the old image", *got.Spec.Replicas, got.Spec.Template.Spec.Containers[0].Image)
	}

	reconcileFleet(t, c, s)
	if got := sts(); got.Spec.Template.Spec.Containers[0].Image != "ghcr.io/denoland/celld:0.6.0" {
		t.Fatal("started the new image while an old node was still running")
	}

	if err := c.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	reconcileFleet(t, c, s)
	if got := sts(); *got.Spec.Replicas != 3 || got.Spec.Template.Spec.Containers[0].Image != "ghcr.io/denoland/celld:0.7.0" {
		t.Fatalf("last step: replicas %d image %s, want 3 on the new image", *got.Spec.Replicas, got.Spec.Template.Spec.Containers[0].Image)
	}
}

func gatekeeperFleet() *kodov1.Fleet {
	f := testFleet()
	f.Spec.Gatekeeper = &kodov1.GatekeeperRef{}
	return f
}

func TestGatekeeperTrustsTheFleetUntilItIsDeleted(t *testing.T) {
	s := testScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(gatekeeperFleet()).WithStatusSubresource(&kodov1.Fleet{}).Build()
	reconcileFleet(t, c, s)
	ctx := context.Background()

	var own, trust corev1.Secret
	if err := c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo-gatekeeper-key"}, &own); err != nil {
		t.Fatal(err)
	}
	if len(own.Data["key"]) != 64 {
		t.Fatalf("fleet key is %d bytes", len(own.Data["key"]))
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "kodo-system", Name: "kodo-gatekeeper-fleets"}, &trust); err != nil {
		t.Fatal(err)
	}
	if string(trust.Data["kodo.kodo"]) != string(own.Data["key"]) {
		t.Error("the Gatekeeper's trust Secret does not hold the fleet's key")
	}

	// A second reconcile keeps the key.
	reconcileFleet(t, c, s)
	var again corev1.Secret
	_ = c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo-gatekeeper-key"}, &again)
	if string(again.Data["key"]) != string(own.Data["key"]) {
		t.Error("the fleet key changed on reconcile")
	}

	env := map[string]corev1.EnvVar{}
	var jobs batchv1.JobList
	_ = c.List(ctx, &jobs)
	for _, e := range jobs.Items[0].Spec.Template.Spec.Containers[0].Env {
		env[e.Name] = e
	}
	if env["GATEKEEPER_URL"].Value != "http://kodo-gatekeeper.kodo-system.svc:8081" || env["FLEET_ID"].Value != "kodo/kodo" ||
		env["GATEKEEPER_KEY"].ValueFrom.SecretKeyRef.Name != "kodo-gatekeeper-key" {
		t.Errorf("kernel Job gatekeeper env: %v", env)
	}

	var fleet kodov1.Fleet
	_ = c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo"}, &fleet)
	if err := c.Delete(ctx, &fleet); err != nil {
		t.Fatal(err)
	}
	reconcileFleet(t, c, s)
	_ = c.Get(ctx, client.ObjectKey{Namespace: "kodo-system", Name: "kodo-gatekeeper-fleets"}, &trust)
	if _, ok := trust.Data["kodo.kodo"]; ok {
		t.Error("a deleted Fleet is still trusted")
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo"}, &fleet); err == nil {
		t.Error("the Fleet's finalizer was not removed")
	}
}

func TestEgressPolicy(t *testing.T) {
	if desiredEgressPolicy(testFleet()) != nil {
		t.Fatal("a Fleet without egress got an egress policy")
	}
	f := gatekeeperFleet()
	bucket := networkingv1.NetworkPolicyEgressRule{To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "203.0.113.7/32"}}}}
	f.Spec.Egress = &kodov1.EgressSpec{Allow: []networkingv1.NetworkPolicyEgressRule{bucket}}
	p := desiredEgressPolicy(f)
	if len(p.Spec.PolicyTypes) != 1 || p.Spec.PolicyTypes[0] != networkingv1.PolicyTypeEgress {
		t.Errorf("policy types %v", p.Spec.PolicyTypes)
	}
	if len(p.Spec.Egress) != 4 {
		t.Fatalf("want DNS, peers, Gatekeeper and the bucket; got %d rules", len(p.Spec.Egress))
	}
	gk := p.Spec.Egress[2]
	if gk.To[0].NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"] != "kodo-system" ||
		gk.Ports[0].Port.IntValue() != 8081 || gk.Ports[1].Port.IntValue() != 8082 {
		t.Errorf("gatekeeper rule %+v", gk)
	}
	nodeEnv := func(f *kodov1.Fleet) map[string]string {
		env := map[string]string{}
		for _, e := range desiredStatefulSet(f).Spec.Template.Spec.Containers[0].Env {
			env[e.Name] = e.Value
		}
		return env
	}
	if _, ok := nodeEnv(f)["HTTPS_PROXY"]; ok {
		t.Error("nodes use the egress proxy without egress.proxy")
	}
	f.Spec.Egress.Proxy = true
	if got := nodeEnv(f)["HTTPS_PROXY"]; got != "http://kodo-gatekeeper.kodo-system.svc:8082" {
		t.Errorf("HTTPS_PROXY %q", got)
	}
	if p.Spec.Egress[3].To[0].IPBlock.CIDR != "203.0.113.7/32" {
		t.Errorf("extra rule not kept: %+v", p.Spec.Egress[3])
	}

	s := testScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(f).WithStatusSubresource(&kodov1.Fleet{}).Build()
	reconcileFleet(t, c, s)
	ctx := context.Background()
	key := client.ObjectKey{Namespace: "kodo", Name: "kodo-egress"}
	if err := c.Get(ctx, key, &networkingv1.NetworkPolicy{}); err != nil {
		t.Fatal(err)
	}
	var fleet kodov1.Fleet
	_ = c.Get(ctx, client.ObjectKey{Namespace: "kodo", Name: "kodo"}, &fleet)
	fleet.Spec.Egress = nil
	_ = c.Update(ctx, &fleet)
	reconcileFleet(t, c, s)
	if err := c.Get(ctx, key, &networkingv1.NetworkPolicy{}); err == nil {
		t.Error("egress policy kept after the Fleet dropped egress")
	}
}
