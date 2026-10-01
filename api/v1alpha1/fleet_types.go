package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// FleetSpec describes a celld fleet running the kodo kernel.
type FleetSpec struct {
	// Celld is the celld node image, e.g. ghcr.io/denoland/celld:0.6.0.
	// Changing it stops every node before starting the new version, because
	// mixed celld versions cannot share a fleet.
	Celld string `json:"celld"`

	// Kernel is the kernel image. The operator runs it as a Job that deploys
	// the kernel to the bucket; nodes adopt it without restarting.
	Kernel string `json:"kernel"`

	// Replicas is the number of celld nodes. Two or more make writes fast.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:default=3
	// +optional
	Replicas int32 `json:"replicas,omitempty"`

	Bucket BucketSpec `json:"bucket"`

	// RuntimeClassName for the nodes, e.g. gvisor.
	// +optional
	RuntimeClassName *string `json:"runtimeClassName,omitempty"`

	// IdleEvictSeconds hibernates a cell after this long without work.
	// +kubebuilder:default=30
	// +optional
	IdleEvictSeconds int32 `json:"idleEvictSeconds,omitempty"`

	// Resources for each node.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// StorageSize of each node's local volume, a cache of the bucket.
	// +kubebuilder:default="2Gi"
	// +optional
	StorageSize resource.Quantity `json:"storageSize,omitempty"`

	// StorageClassName for the node volumes; the cluster default if unset.
	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`

	// Auth is the OIDC provider whose ID tokens the kernel accepts. Without
	// it only the operator's admin token is accepted.
	// +optional
	Auth *AuthSpec `json:"auth,omitempty"`

	// Gatekeeper connects the kernel to a Gatekeeper, which makes the external
	// calls gadgets are granted. The operator gives the fleet a signing key
	// and adds it to the Gatekeeper's trusted fleets. Without it, capability
	// calls fail.
	// +optional
	Gatekeeper *GatekeeperRef `json:"gatekeeper,omitempty"`

	// Egress, when set, denies the nodes every outbound connection except
	// DNS, the fleet's own nodes, the Gatekeeper and the destinations listed
	// in it: the bucket endpoint, the identity provider's keys and, later,
	// the inference gateway.
	// +optional
	Egress *EgressSpec `json:"egress,omitempty"`
}

// GatekeeperRef locates the Gatekeeper a fleet calls.
type GatekeeperRef struct {
	// Namespace the Gatekeeper runs in.
	// +kubebuilder:default=kodo-system
	// +optional
	Namespace string `json:"namespace,omitempty"`
	// Service is the Gatekeeper's Service; its internal port is 8081.
	// +kubebuilder:default=kodo-gatekeeper
	// +optional
	Service string `json:"service,omitempty"`
	// TrustSecret is the Secret in Namespace that holds one key per trusted
	// fleet, mounted into the Gatekeeper.
	// +kubebuilder:default=kodo-gatekeeper-fleets
	// +optional
	TrustSecret string `json:"trustSecret,omitempty"`
}

// EgressSpec is the outbound traffic a fleet's nodes may make.
type EgressSpec struct {
	// Proxy sends the nodes' HTTPS traffic, which is their bucket traffic,
	// through the Gatekeeper's egress proxy, which tunnels only to the hosts
	// it allows. Use it when the bucket endpoint has no fixed addresses to
	// allow. Needs gatekeeper.
	// +optional
	Proxy bool `json:"proxy,omitempty"`

	// Allow are extra egress rules, in NetworkPolicy form.
	// +optional
	Allow []networkingv1.NetworkPolicyEgressRule `json:"allow,omitempty"`
}

// AuthSpec configures how the kernel verifies callers.
type AuthSpec struct {
	// Issuer is the OIDC issuer URL, e.g. https://auth.example.com.
	Issuer string `json:"issuer"`
	// Audience is the OIDC client id the gateway logs users in with.
	Audience string `json:"audience"`
	// JWKSURL is where the kernel fetches the issuer's signing keys; it may
	// be an in-cluster URL. Defaults to <issuer>/keys.
	// +optional
	JWKSURL string `json:"jwksURL,omitempty"`
}

// BucketSpec locates the fleet's bucket and its credentials.
type BucketSpec struct {
	// Name of the bucket, optionally followed by /prefix.
	Name string `json:"name"`
	// Endpoint of an S3-compatible store; AWS S3 if unset.
	// +optional
	Endpoint string `json:"endpoint,omitempty"`
	// Region; "auto" for Tigris.
	// +optional
	Region string `json:"region,omitempty"`
	// CredentialsSecret names a Secret in the Fleet's namespace with the keys
	// AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
	CredentialsSecret string `json:"credentialsSecret"`
}

// FleetStatus reports what the operator has rolled out.
type FleetStatus struct {
	// ObservedGeneration is the generation this status describes.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// ReadyReplicas is the number of ready nodes.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`
	// Celld is the node image currently running.
	// +optional
	Celld string `json:"celld,omitempty"`
	// Kernel is the kernel image last deployed successfully.
	// +optional
	Kernel string `json:"kernel,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Fleet is a set of celld nodes sharing one bucket and running the kernel.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Celld",type=string,JSONPath=`.status.celld`
// +kubebuilder:printcolumn:name="Kernel",type=string,JSONPath=`.status.kernel`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type Fleet struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   FleetSpec   `json:"spec,omitempty"`
	Status FleetStatus `json:"status,omitempty"`
}

// FleetList is a list of Fleets.
// +kubebuilder:object:root=true
type FleetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Fleet `json:"items"`
}
