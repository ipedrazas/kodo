package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// WorkspaceSpec configures a workspace in a Fleet. The workspace takes the
// resource's name.
type WorkspaceSpec struct {
	// Fleet is the Fleet in this namespace the workspace lives in.
	Fleet string `json:"fleet"`

	// Quota is the most cells the workspace may hold.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:default=100
	// +optional
	Quota int32 `json:"quota,omitempty"`
}

// WorkspaceStatus reports the workspace as the kernel sees it.
type WorkspaceStatus struct {
	// Cells is the number of cells in the workspace.
	// +optional
	Cells int32 `json:"cells,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Workspace configures one workspace of a Fleet. Deleting the resource does
// not delete the workspace or its cells.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Quota",type=integer,JSONPath=`.spec.quota`
// +kubebuilder:printcolumn:name="Cells",type=integer,JSONPath=`.status.cells`
type Workspace struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   WorkspaceSpec   `json:"spec,omitempty"`
	Status WorkspaceStatus `json:"status,omitempty"`
}

// WorkspaceList is a list of Workspaces.
// +kubebuilder:object:root=true
type WorkspaceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Workspace `json:"items"`
}
