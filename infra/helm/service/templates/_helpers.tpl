{{/* The release name is the service name (auth-service, ...): it is also the Service DNS name. */}}
{{- define "svc.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "svc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "svc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "svc.labels" -}}
{{ include "svc.selectorLabels" . }}
app.kubernetes.io/part-of: fraudguard
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "svc.image" -}}
{{- if or (not .Values.image.repository) (not .Values.image.tag) -}}
{{- fail "image.repository and image.tag are required (set them in values-<service>.yaml)" -}}
{{- end -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}

{{/* A path to a writable directory -> a valid volume name ("/etc/nginx/conf.d" -> "w-etc-nginx-conf-d"). */}}
{{- define "svc.volumeName" -}}
{{- printf "w%s" (. | replace "/" "-" | replace "." "-" | replace "_" "-") | trunc 63 | trimSuffix "-" -}}
{{- end -}}
