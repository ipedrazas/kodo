// Package v1alpha1 contains the kodo.dev/v1alpha1 API: Fleet, Blueprint and
// Workspace.
// +kubebuilder:object:generate=true
// +groupName=kodo.dev
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var (
	GroupVersion  = schema.GroupVersion{Group: "kodo.dev", Version: "v1alpha1"}
	SchemeBuilder = runtime.NewSchemeBuilder(addKnownTypes)
	AddToScheme   = SchemeBuilder.AddToScheme
)

func addKnownTypes(s *runtime.Scheme) error {
	s.AddKnownTypes(GroupVersion,
		&Fleet{}, &FleetList{},
		&Blueprint{}, &BlueprintList{},
		&Workspace{}, &WorkspaceList{},
	)
	metav1.AddToGroupVersion(s, GroupVersion)
	return nil
}
