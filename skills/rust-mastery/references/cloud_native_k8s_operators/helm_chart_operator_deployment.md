# Panduan Enterprise: Production Kubernetes Deployment Helm Chart & RBAC untuk Rust Operator

Dokumen ini adalah referensi kelas sultan untuk mendeploy Rust Kubernetes Operator di lingkungan produksi menggunakan Helm, mencakup konfigurasi Kubernetes Manifests (Deployment, RBAC), Service Accounts, TCP/HTTP probes, dan strategi scaling.

## Arsitektur Deployment Kubernetes

```text
+-------------------------------------------------------------+
|                     KUBERNETES CLUSTER                      |
|                                                             |
|  +--------------------+       +--------------------------+  |
|  |    RBAC & Auth     |       |       Control Plane      |  |
|  |                    |       |                          |  |
|  | [ClusterRole]      |       | [Kube-APIServer]         |  |
|  |        |           |       |        ^                 |  |
|  | [ClusterRoleBinding]------ |        | (HTTPS / gRPC)  |  |
|  |        |           |       |        v                 |  |
|  | [ServiceAccount] <======== | [Rust Operator Pod(s)]   |  |
|  +--------------------+       |  |                       |  |
|                               |  |-- Liveness Probe      |  |
|                               |  |-- Readiness Probe     |  |
|                               |  |-- Prometheus Metrics  |  |
|                               +--------------------------+  |
+-------------------------------------------------------------+
```

## 1. Helm Values (values.yaml)

Konfigurasi `values.yaml` yang ketat dan production-ready, mengatur resources, node affinity, dan tolerations.

```yaml
# values.yaml
replicaCount: 2

image:
  repository: my-registry.com/rust-operator
  pullPolicy: IfNotPresent
  tag: "v1.2.0"

serviceAccount:
  create: true
  name: "rust-operator-sa"
  annotations: {}

rbac:
  create: true

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/metrics"

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 20
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /readyz
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  successThreshold: 1
  failureThreshold: 3

nodeSelector:
  kubernetes.io/os: linux

tolerations: []

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - rust-operator
          topologyKey: kubernetes.io/hostname
```

## 2. RBAC & Service Account Manifests

### Service Account (templates/serviceaccount.yaml)
```yaml
{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "rust-operator.serviceAccountName" . }}
  labels:
    {{- include "rust-operator.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
```

### ClusterRole (templates/clusterrole.yaml)
Memberikan izin minimal (Least Privilege) yang dibutuhkan Rust Operator untuk mengelola Custom Resources dan resources bawaan Kubernetes (misalnya ConfigMap, Pod).

```yaml
{{- if .Values.rbac.create -}}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "rust-operator.fullname" . }}-manager-role
  labels:
    {{- include "rust-operator.labels" . | nindent 4 }}
rules:
  - apiGroups: ["my.domain.com"]
    resources: ["mycustomresources"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["my.domain.com"]
    resources: ["mycustomresources/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: ["my.domain.com"]
    resources: ["mycustomresources/finalizers"]
    verbs: ["update"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list", "watch"]
{{- end }}
```

### ClusterRoleBinding (templates/clusterrolebinding.yaml)
```yaml
{{- if .Values.rbac.create -}}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ include "rust-operator.fullname" . }}-manager-rolebinding
  labels:
    {{- include "rust-operator.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ include "rust-operator.fullname" . }}-manager-role
subjects:
  - kind: ServiceAccount
    name: {{ include "rust-operator.serviceAccountName" . }}
    namespace: {{ .Release.Namespace }}
{{- end }}
```

## 3. Deployment Manifest (templates/deployment.yaml)

Deployment yang aman dengan strict Security Context, Probes, dan Anti-Affinity.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "rust-operator.fullname" . }}
  labels:
    {{- include "rust-operator.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "rust-operator.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "rust-operator.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "rust-operator.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ .Chart.Name }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http-metrics
              containerPort: 8080
              protocol: TCP
          livenessProbe:
            {{- toYaml .Values.livenessProbe | nindent 12 }}
          readinessProbe:
            {{- toYaml .Values.readinessProbe | nindent 12 }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          env:
            - name: RUST_LOG
              value: "info,my_operator=debug"
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

## 4. Implementasi Probes & Metrics di Rust (Axum)

Berikut adalah contoh implementasi endpoint HTTP untuk Readiness (`/readyz`) dan Liveness (`/healthz`) di dalam Rust Operator menggunakan `axum`.

```rust
use axum::{
    routing::get,
    Router,
    http::StatusCode,
    response::IntoResponse,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    is_ready: Arc<AtomicBool>,
}

pub async fn start_health_server(port: u16, is_ready: Arc<AtomicBool>) {
    let state = AppState { is_ready };

    let app = Router::new()
        .route("/healthz", get(liveness_probe))
        .route("/readyz", get(readiness_probe))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Starting health/metrics server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap_or_else(|err| {
        tracing::error!("Failed to start health server: {}", err);
    });
}

async fn liveness_probe() -> impl IntoResponse {
    // Liveness probe selalu me-return 200 OK selama thread tidak panic/deadlock
    (StatusCode::OK, "OK")
}

async fn readiness_probe(axum::extract::State(state): axum::extract::State<AppState>) -> impl IntoResponse {
    if state.is_ready.load(Ordering::SeqCst) {
        (StatusCode::OK, "Ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "Not Ready")
    }
}
```

## 5. Verifikasi Deployment & Integration Testing

### Verifikasi Manual
Gunakan perintah kubectl berikut untuk memverifikasi bahwa deployment berjalan dengan baik:
```bash
# Instal chart
helm install my-rust-operator ./helm-chart --namespace my-operator-system --create-namespace

# Cek Pods
kubectl get pods -n my-operator-system -l app.kubernetes.io/name=rust-operator

# Cek logs dari operator
kubectl logs -f deployment/my-rust-operator -n my-operator-system

# Port-forward untuk cek endpoint /readyz
kubectl port-forward svc/my-rust-operator-metrics 8080:8080 -n my-operator-system &
curl http://localhost:8080/readyz
```

### Helm Test (templates/tests/test-connection.yaml)
Buat helm test untuk otomatisasi verifikasi.
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: "{{ include "rust-operator.fullname" . }}-test-connection"
  labels:
    {{- include "rust-operator.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": test
spec:
  containers:
    - name: wget
      image: busybox
      command: ['wget']
      args: ['{{ include "rust-operator.fullname" . }}:8080/healthz']
  restartPolicy: Never
```

## 6. Critical Anti-Patterns (❌ vs ✅)

### Anti-Pattern 1: Menjalankan Operator sebagai Root Container
❌ **Anti-Pattern**: Menggunakan user `root` (default container) tanpa `SecurityContext` menyebabkan potensi eksploitasi node jika terjadi RCE pada Rust container.
✅ **Best Practice**: Gunakan `runAsNonRoot: true` dan jatuhkan semua `capabilities`.
```yaml
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

### Anti-Pattern 2: Missing Resource Limits pada Operator
❌ **Anti-Pattern**: Tidak mendefinisikan `resources.limits`. Memori leak dari Custom Resource (CRD) cache akan membunuh node tetangga karena OOM-killer membunuh pod lain, bukan operator.
✅ **Best Practice**: Set batas yang tegas di `resources.limits.memory` agar pod di-restart oleh OOM-killer Kubernetes sebelum menghancurkan node.

## 7. Production Edge Cases

1. **Leader Election Splitting (Split-Brain)**
   - **Kasus**: Operator dijalankan lebih dari 1 replica (HA), namun Leader Election (berbasis Kubernetes Leases) gagal atau putus karena network partition, menyebabkan dua controller memodifikasi resource yang sama.
   - **Mitigasi**: Pastikan `kube-rs` terkonfigurasi dengan Leader Election (Lease API) dan waktu sewa (LeaseDuration) disetel ke timeout yang toleran terhadap jitter API Server (mis. 15s).

2. **API Server Rate Limiting & Throttling**
   - **Kasus**: Saat cluster memiliki 10.000+ Custom Resources, operator yang baru menyala (Readiness) akan melakukan List and Watch, meledakkan (DDoS) kube-apiserver atau dibatasi oleh kubelet.
   - **Mitigasi**: Setel parameter `page_size` yang rendah (mis. `500`) pada stream watcher, gunakan pagination di List calls, dan setel `RUST_LOG` untuk memantau waktu respons Kubernetes API.

3. **RBAC Stale Cache & Privilege Escalation Denial**
   - **Kasus**: ClusterRole diperbarui untuk men-drop *verb* tertentu, tapi operator masih mencoba memanggil API yang kini diblokir, mengakibatkan 403 Forbidden panics.
   - **Mitigasi**: Error dari API (`kube::Error::Api`) harus ditangani dengan gracefully di dalam Rekonsiliasi (mengembalikan requeue atau error log) daripada melakukan `unwrap()` yang mematikan worker thread.
