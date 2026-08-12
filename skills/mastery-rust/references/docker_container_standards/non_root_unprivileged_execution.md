# 🚀 Non-Root Unprivileged Execution (Benteng Container Rust)

## 1. Anatomi Kerentanan Root Container
Berjalan sebagai `root` (UID 0) di dalam Docker adalah dosa besar di mata arsitek keamanan. Walaupun terisolasi, proses root di dalam container secara default adalah root yang sama dengan daemon Docker host. Jika ada kerentanan kernel (seperti eksploit *container escape* DirtyPipe / CVE-2022-0847) atau aplikasi Anda diserang lewat Arbitrary Code Execution, attacker dapat lepas dan menyabotase server induk.

Praktik Sultan menuntut **Unprivileged Execution**: 
1. Eksekusi program murni dengan UID 10001+ (non-system ID).
2. Cabut semua Linux Capabilities bawaan Docker (`drop: ALL`).
3. Paksa file system menjadi Read-Only (`readOnlyRootFilesystem: true`).

### Diagram ASCII: Lapisan Pertahanan Container Rust
```text
[ Docker Daemon Host ]
   |
   +-- [ Container Sandbox ]
        |
        |--- Linux Capabilities: DROP ALL (Tak bisa mount, chown, ptrace)
        |--- Root FS: READ ONLY (Tidak bisa menginjeksi malware ke /usr/bin)
        |--- User: uid=10001 (AppUser), gid=10001
        |
        +---> [ ./my_rust_server ] (Hanya bisa listen di port > 1024)
              |
              +-- Tulis log/sementara? Hanya bisa ke mount tmpfs /tmp
```

## 2. Dockerfile & Konfigurasi Kubernetes
Bagaimana menerapkannya ke image `distroless` dan integrasi manifest K8s.

### Dockerfile
```dockerfile
FROM rust:1.75 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --bin secure_rust_app

FROM gcr.io/distroless/cc-debian12:nonroot
# User 'nonroot' disediakan oleh distroless dengan UID 65532, GID 65532.
# Distroless secara natural sudah membuang bash, curl, dsb.

WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /app/target/release/secure_rust_app /app/secure_rust_app

USER nonroot:nonroot
EXPOSE 8080

ENTRYPOINT ["/app/secure_rust_app"]
```

### Manifest K8s Pod Security Context (Mewajibkan Non-Root)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rust-secure-app
spec:
  template:
    spec:
      securityContext:
        runAsUser: 65532       # Pastikan tidak sama dengan root
        runAsGroup: 65532
        fsGroup: 65532
        runAsNonRoot: true     # Kubernetes akan MENOLAK start jika image memaksa root!
      containers:
        - name: secure-container
          image: my_rust_registry/secure_rust_app:latest
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL          # Cabut semua hak super-user Linux (CHOWN, NET_RAW, dll)
          volumeMounts:
            - mountPath: /tmp
              name: tmp-vol
      volumes:
        - name: tmp-vol
          emptyDir: {}         # tmpfs untuk writing jika app harus menulis temp files
```

## 3. Unit / Verification Script
Skrip bash ini membuktikan bahwa kontainer berjalan sebagai non-root dan melepaskan capabilites (menggunakan `capsh` jika tersedia di image standar, namun karena ini distroless, kita tes dari inspeksi config).

```bash
#!/bin/bash
set -e

IMAGE="secure_rust_app_test:latest"
docker build -t $IMAGE -f Dockerfile .

echo "[*] Verifying UID..."
USER_ID=$(docker inspect -f '{{.Config.User}}' $IMAGE)
if [[ "$USER_ID" == "root" || "$USER_ID" == "0" || "$USER_ID" == "" ]]; then
    echo "❌ ERROR: Image is running as root or user is not explicitly set!"
    exit 1
else
    echo "✅ SUCCESS: Image is set to use user: $USER_ID"
fi

echo "[*] Dry Run as Read-Only and Drop-All..."
docker run --rm -d \
  --name security_test \
  --read-only \
  --cap-drop=ALL \
  --user 65532:65532 \
  -p 8080:8080 \
  $IMAGE

sleep 2

if docker ps | grep -q security_test; then
    echo "✅ SUCCESS: Container successfully runs under strict security constraints."
    docker stop security_test
else
    echo "❌ ERROR: Container crashed! Check if it tries to write to RO file system or bind protected port."
    docker logs security_test || true
    exit 1
fi
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Binding Port di bawah 1024
Aplikasi Rust memanggil `TcpListener::bind("0.0.0.0:80")`.
**Masalah**: Port di bawah 1024 (Privileged Ports) membutuhkan `CAP_NET_BIND_SERVICE`. Karena kita men-drop `ALL` Linux capabilities dan menggunakan Non-Root, `bind()` akan mereturn `PermissionDenied`.
**Solusi (✅)**: Dengarkan pada port 8080 atau 3000. Biarkan NGINX / Kubernetes Ingress / Docker NAT yang memetakan trafik dari port 80/443 eksternal menuju port 8080 kontainer.

### ❌ Anti-Pattern 2: Logging ke File Lokal `/var/log/app.log`
**Masalah**: Direktori `/var/log` dimiliki oleh root, dan kita mengunci sistem sebagai `readOnlyRootFilesystem`. Mencoba membuat file `File::create("/var/log/app.log")` akan mereturn `ReadOnlyFS`.
**Solusi (✅)**: Selalu emit log ke `stdout` / `stderr` menggunakan library `tracing` atau `env_logger`. Biarkan orchestrator (Fluentd, Promtail, Vector) menangkap output stdout dari kontainer.

## 5. Production Edge Cases

1. **Membutuhkan File Konfigurasi TLS di Runtime (.pem / .crt)**:
   Aplikasi membutuhkan file sertifikat SSL private untuk gRPC mTLS. Jika rootFS read-only, bagaimana menulis sertifikat yang didapat via Vault? **Mitigasi**: Gunakan Kubernetes Secrets yang di-mount sebagai `Volume`. Kubernetes akan secara otomatis memproyeksikan mount direktori read-only (misal `/etc/app-certs/tls.crt`) dalam memori (tmpfs) yang aman untuk dibaca aplikasi, tanpa menyentuh container disk layer.

2. **Library Native Mengandalkan Akses Sysfs / Procfs**:
   Beberapa framework profiling atau driver perangkat keras mencoba membaca dari direktori `/proc` atau `/sys/devices/`. Karena capabilities di-drop, akses mungkin ditolak. **Mitigasi**: Pastikan dependensi (seperti pengukur CPU internal) dirancang *container-aware*. Jika wajib butuh, berikan Linux Capability minimum (misal `CAP_SYS_PTRACE`) HANYA di namespace kontainer yang sangat spesifik, jangan gunakan flag `--privileged`.

3. **Gagal Membuat Temporary Database SQLite**:
   Mencoba membuat in-memory SQLite yang membutuhkan swap file, atau menulis temporary blobs memori. Karena rootfs readonly, rust program akan crash. **Mitigasi**: Kubernetes harus menyediakan `emptyDir: {}` di `/tmp`. Aplikasi rust wajib mengonfigurasi direktori sementara ke `/tmp` (mengatur env `TMPDIR=/tmp`).
