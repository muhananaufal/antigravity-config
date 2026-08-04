# Blueprint Manifest Kubernetes & Helm Charts Kasta Sultan untuk NestJS

## 1. Visi Arsitektur Infrastruktur (Top 1% Engineering)

Dalam merancang spesifikasi Deployment Kubernetes dan Helm Charts untuk aplikasi NestJS pada skala produksi, kelas Quality of Service (QoS) Kubernetes sangat menentukan stabilitas latensi dan performa aplikasi di bawah tekanan tinggi. Blueprint ini menjabarkan spesifikasi kasta sultan: QoS Guaranteed, di mana nilai CPU dan Memory `requests` sepenuhnya sejajar dan identik dengan `limits`. Pendekatan ini mencegah Eviction Pod saat node mengalami tekanan memori berlebih, serta mencegah CPU throttling yang berlebihan.

Blueprint ini juga mendefinisikan rancangan StatefulSet (jika diperlukan untuk caching lokal atau koneksi websocket persisten) beserta Ingress controller mutakhir. Konfigurasi ini menjamin bahwa seluruh Pod yang berjalan tidak akan pernah berkompetisi secara liar memperebutkan resource Node.

## 2. Topologi Arsitektur Kubernetes

```text
+-------------------------------------------------------------+
| KUBERNETES CLUSTER (Production)                             |
|                                                             |
|  +-----------------+      +------------------------------+  |
|  | Ingress NGINX / |      |  Kubernetes Service          |  |
|  | AWS ALB         | ---> |  (ClusterIP / Headless)      |  |
|  +-----------------+      +------------------------------+  |
|                                      |                      |
|           +--------------------------+-----------------+    |
|           |                                            |    |
|  +-----------------------+                 +-----------------------+
|  | Pod (NestJS App 1)    |                 | Pod (NestJS App 2)    |
|  | QoS: Guaranteed       |                 | QoS: Guaranteed       |
|  | CPU: 1000m / 1000m    |                 | CPU: 1000m / 1000m    |
|  | Mem: 1Gi / 1Gi        |                 | Mem: 1Gi / 1Gi        |
|  | Liveness: /health     |                 | Liveness: /health     |
|  +-----------------------+                 +-----------------------+
|                                                             |
+-------------------------------------------------------------+
```

## 3. Implementasi Helm Chart (values.yaml & deployment.yaml)

Berikut adalah cetak biru `deployment.yaml` murni berbasis Helm yang menonjolkan QoS Guaranteed, anti-affinity untuk High Availability (HA), dan probe kustom mutakhir.

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "nestjs-app.fullname" . }}
  labels:
    {{- include "nestjs-app.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "nestjs-app.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "nestjs-app.selectorLabels" . | nindent 8 }}
    spec:
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
                  - {{ include "nestjs-app.name" . }}
              topologyKey: "kubernetes.io/hostname"
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          resources:
            requests:
              cpu: {{ .Values.resources.cpu }}
              memory: {{ .Values.resources.memory }}
            limits:
              cpu: {{ .Values.resources.cpu }}
              memory: {{ .Values.resources.memory }}
          livenessProbe:
            httpGet:
              path: /health/liveness
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/readiness
              port: http
            initialDelaySeconds: 15
            periodSeconds: 5
            timeoutSeconds: 3
            successThreshold: 1
            failureThreshold: 3
          envFrom:
            - configMapRef:
                name: {{ include "nestjs-app.fullname" . }}-config
            - secretRef:
                name: {{ include "nestjs-app.fullname" . }}-secret
```

Nilai `values.yaml` wajib menyertakan alokasi resource identik:
```yaml
# values.yaml
replicaCount: 3
image:
  repository: my-registry/nestjs-app
  tag: "v1.2.3"
  pullPolicy: IfNotPresent
service:
  port: 3000
resources:
  cpu: "1000m"
  memory: "1Gi"
```

## 4. Implementasi NestJS Liveness & Readiness Probes

Untuk melengkapi Helm Chart di atas, kita harus menyajikan titik akhir `Terminus` di aplikasi NestJS.

```typescript
// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HttpHealthIndicator, MemoryHealthIndicator, TypeOrmHealthIndicator } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Get('liveness')
  @HealthCheck()
  public checkLiveness(): Promise<unknown> {
    // Liveness hanya mengecek apakah aplikasi masih berjalan secara fundamental.
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 700 * 1024 * 1024), // Maksimum 700MB dari 1GB Limit
    ]);
  }

  @Get('readiness')
  @HealthCheck()
  public checkReadiness(): Promise<unknown> {
    // Readiness mengecek apakah dependencies seperti DB sudah siap menerima trafik.
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.http.pingCheck('external_api', 'https://api.external.service.com/ping'),
    ]);
  }
}
```

## 5. Unit / K8s Watcher Mock Test Suite

```typescript
// src/health/health.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthCheckService, HttpHealthIndicator, MemoryHealthIndicator, TypeOrmHealthIndicator } from '@nestjs/terminus';

describe('HealthController (Kubernetes Probes)', () => {
  let controller: HealthController;
  let mockHealthCheckService: Partial<HealthCheckService>;
  let mockMemoryIndicator: Partial<MemoryHealthIndicator>;
  let mockDbIndicator: Partial<TypeOrmHealthIndicator>;

  beforeEach(async () => {
    mockHealthCheckService = {
      check: jest.fn().mockImplementation((indicators: Array<() => Promise<any>>) => {
        return Promise.all(indicators.map((indicator) => indicator()));
      }),
    };
    mockMemoryIndicator = {
      checkHeap: jest.fn().mockResolvedValue({ memory_heap: { status: 'up' } }),
    };
    mockDbIndicator = {
      pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: MemoryHealthIndicator, useValue: mockMemoryIndicator },
        { provide: TypeOrmHealthIndicator, useValue: mockDbIndicator },
        { provide: HttpHealthIndicator, useValue: { pingCheck: jest.fn() } },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('seharusnya memverifikasi liveness probe dengan pengecekan memori (QoS Constraint)', async () => {
    const result = await controller.checkLiveness();
    expect(mockHealthCheckService.check).toHaveBeenCalled();
    expect(mockMemoryIndicator.checkHeap).toHaveBeenCalledWith('memory_heap', 700 * 1024 * 1024);
    expect(result).toEqual([{ memory_heap: { status: 'up' } }]);
  });

  it('seharusnya memverifikasi readiness probe dengan DB ping', async () => {
    const result = await controller.checkReadiness();
    expect(mockHealthCheckService.check).toHaveBeenCalled();
    expect(mockDbIndicator.pingCheck).toHaveBeenCalledWith('database', { timeout: 3000 });
  });
});
```

## 6. Analisis Trade-Off

### Kelebihan
1. **Prediktabilitas Performa**: QoS Guaranteed mencegah Pod mengalami throttling CPU secara acak akibat Noisy Neighbor di Node.
2. **Resiliensi Skala Besar**: Pod Anti-Affinity menyebar beban ke seluruh zona dan node, mencegah satu node down menumbangkan seluruh mikroservis.
3. **Isolasi Kegagalan**: Memisahkan Liveness dan Readiness Probe mencegah Kubernetes me-restart Pod ketika hanya koneksi Database yang sedang berkedip (flapping).

### Kekurangan
1. **Pemborosan Resource (Overprovisioning)**: Jika aplikasi tidak memakai 1000m CPU secara penuh, resource tersebut tetap dikunci dan tidak bisa dipinjam oleh Pod lain.
2. **Kekakuan Skeduler**: Memerlukan node dengan kapasitas besar yang tersedia. Jika tidak ada node dengan blok resource utuh yang cukup, Pod akan berstatus `Pending`.
3. **Kompleksitas Manajemen Node**: Membutuhkan pemantauan metrik utilisasi node yang sangat teliti agar Cluster Autoscaler tidak sering scaling up sia-sia.

## 7. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggabungkan Liveness dan Readiness pada Probe yang Sama
Jika Liveness probe gagal hanya karena koneksi database lambat, Kubernetes akan membunuh Pod tersebut (SIGKILL/SIGTERM). Padahal, membunuh aplikasi Node.js tidak akan memperbaiki koneksi database eksternal.

**Salah:**
```yaml
livenessProbe:
  httpGet:
    path: /health/all-in-one
# Membunuh pod karena DB timeout
```

**Benar:**
```yaml
livenessProbe:
  httpGet:
    path: /health/liveness
# Liveness hanya mengecek event loop / memory. Readiness mengecek eksternal DB.
```

### ❌ Anti-Pattern 2: QoS Burstable (Requests < Limits)
Memberikan Limits yang jauh lebih besar dari Requests menyebabkan CPU throttling di kernel Linux (CFS Bandwidth Control) jika pod lain di node yang sama tiba-tiba menuntut CPU tinggi. Ini menyebabkan lonjakan latensi p99 NestJS yang misterius.

**Salah:**
```yaml
requests:
  cpu: 100m
limits:
  cpu: 1000m
```

**Benar:**
```yaml
requests:
  cpu: 1000m
limits:
  cpu: 1000m
```

## 8. Production Edge Cases

1. **OOM Killed vs Heap Out of Memory**: V8 Engine NestJS mungkin mengalami kegagalan `heap out of memory` SEBELUM Kubernetes `OOMKilled` terjadi jika flag `--max-old-space-size` tidak diatur. Wajib menetapkan limit Node.js sekitar 75-80% dari limit Pod Kubernetes.
2. **Graceful Shutdown Timeout**: Jika `terminationGracePeriodSeconds` di Kubernetes adalah 30s, pastikan NestJS merespons `SIGTERM` dan menyelesaikan semua Request HTTP & job antrean dalam waktu kurang dari 25s, agar tidak diputus paksa (SIGKILL) sebelum tuntas.
3. **DNS Lookup Latency dalam Alpine Images**: Menggunakan image basis Alpine terkadang memicu bug musl libc DNS lookup timeout 5s pada trafik tinggi. Pertimbangkan menggunakan image debian-slim atau google distroless untuk production kritis jika koneksi eksternal masif terjadi.
