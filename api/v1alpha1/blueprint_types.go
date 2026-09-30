package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// BlueprintSpec is one published version of a Blueprint. Versions are
// immutable in the kernel, so the spec cannot change after creation.
// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="a Blueprint version is immutable; create a new resource for a new version"
type BlueprintSpec struct {
	// Fleet is the Fleet in this namespace to publish to.
	Fleet string `json:"fleet"`

	// Blueprint is the name, e.g. notes.
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`
	Blueprint string `json:"blueprint"`

	// Version, e.g. 1.2.0.
	// +kubebuilder:validation:Pattern=`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`
	Version string `json:"version"`

	// Source is the gadget module, read from a ConfigMap key.
	Source corev1.ConfigMapKeySelector `json:"source"`

	// Capabilities the gadget may be granted, <provider>:<resource>:<verb>.
	// +optional
	Capabilities []string `json:"capabilities,omitempty"`

	// Tier selects the kind of fleet the gadget runs on.
	// +kubebuilder:default=shared
	// +optional
	Tier string `json:"tier,omitempty"`
}

// BlueprintStatus reports the publication.
type BlueprintStatus struct {
	// Digest is the SHA-256 of the published bundle.
	// +optional
	Digest string `json:"digest,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Blueprint publishes one gadget version to a Fleet's catalog.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Blueprint",type=string,JSONPath=`.spec.blueprint`
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Published",type=string,JSONPath=`.status.conditions[?(@.type=="Published")].status`
type Blueprint struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BlueprintSpec   `json:"spec,omitempty"`
	Status BlueprintStatus `json:"status,omitempty"`
}

// BlueprintList is a list of Blueprints.
// +kubebuilder:object:root=true
type BlueprintList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Blueprint `json:"items"`
}
