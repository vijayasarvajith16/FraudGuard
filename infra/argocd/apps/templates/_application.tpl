{{/*
One Argo CD Application. Arguments (dict): root (the chart context), name, wave, path, valueFiles.
Automated sync with prune (resources removed from Git are deleted) and self-heal (manual changes
in the cluster are reverted).
*/}}
{{- define "fraudguard.application" -}}
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ .name }}
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: fraudguard
  annotations:
    argocd.argoproj.io/sync-wave: {{ .wave | quote }}
  # Deleting the Application also deletes the resources it manages.
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: fraudguard
  source:
    repoURL: {{ .root.Values.repoURL }}
    targetRevision: {{ .root.Values.targetRevision }}
    path: {{ .path }}
    {{- if .helm }}
    helm:
      releaseName: {{ .name }}
      {{- with .valueFiles }}
      valueFiles:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    {{- end }}
  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .root.Values.namespace }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 5
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 3m
{{- end -}}
