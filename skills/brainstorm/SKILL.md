---
name: brainstorm
description: Gunakan skill ini ketika user mengajak brainstorming, menggali ide, menimbang opsi, atau berdiskusi strategi — baik topik non-teknis (bisnis, produk, karir) maupun topik teknikal/arsitektural (pilih tech-stack, pola distribusi, evaluasi trade-off sistem).
---

# Brainstorming

Skill ini melayani dua mode: **Non-Teknis** (ide umum/bisnis) dan **Teknikal / Arsitektural** (evaluasi stack, arsitektur, trade-off sistem).

---

## 💡 Mode 1: Brainstorming Non-Teknis

**§3, §5, §6, §7 `AGENTS.md` MATI di sini** — tanpa quality gate kode, template artefak formal, atau pengingat test. Yang tetap hidup: §8 (bahasa & kepadatan), §4 (Challenger), dan §9 (catat ke `shared/LEARNED.md` jika ada koreksi/mekanisme baru).

### Urutan WAJIB (Non-Teknis)

| # | Langkah | Aturannya |
| :--- | :--- | :--- |
| 1 | **Divergen** | ≥7 opsi mentah sebelum satu pun dikomentari. DILARANG menilai di fase ini. Ide WAJIB beragam sumbu — kalau semuanya berbagi satu asumsi, sebutkan asumsi itu lalu buat ide yang sengaja melanggarnya. |
| 2 | **Bongkar asumsi** | WAJIB tulis asumsi penopang tiap arah sebelum menilai. Asumsi tak tertulis adalah sumber utama kesepakatan semu. |
| 3 | **Label epistemik** | Tandai tiap klaim: `[fakta]` bisa diverifikasi · `[inferensi]` kesimpulan dari fakta · `[spekulasi]` tebakan terdidik. DILARANG mencampur tanpa label. |
| 4 | **Steelman** | DILARANG menolak ide sebelum menyajikan versi terkuatnya. Belum bisa merumuskan versi terkuatnya = belum paham idenya, bukan idenya yang lemah. |
| 5 | **Kriteria dulu** | WAJIB sepakati kriteria penilaian dengan user SEBELUM menyaring. Kriteria yang disusun sambil jalan hanya merasionalisasi favorit yang sudah dipilih diam-diam. |
| 6 | **Konvergen** | Sajikan ≥3 arah + trade-off (§4 `AGENTS.md`). DILARANG label "(Recommended)" sepihak kecuali diminta. Tiap arah WAJIB disertai **apa yang akan membatalkannya** — tak ada pembatal berarti itu harapan, bukan strategi. |

### Anti-Pattern Non-Teknis

| DILARANG | Kenapa berbahaya |
| :--- | :--- |
| Menilai ide pertama seketika | Menjangkarkan seluruh diskusi ke satu titik |
| Tujuh ide yang cuma parafrase satu tema | Divergensi palsu, ilusi sudah eksplorasi luas |
| Menyetujui tanpa menantang | Yes-man, melanggar §4 |
| Spekulasi disajikan bernada fakta | Keputusan besar berdiri di atas tebakan |
| Menyimpulkan sebelum user selesai bercerita | Memecahkan masalah yang salah dengan rapi |
| Menawarkan solusi saat user baru mengeluh | Belum tentu user minta dipecahkan |

---

## 🏛️ Mode 2: Brainstorming Teknikal / Arsitektural (§Teknikal)

Dipicu saat user berdiskusi soal: pemilihan stack/database, pemecahan modul/monolit, pola messaging/eventing, konsistensi data (ACID vs BASE), caching strategy, atau trade-off desain sistem.

### Aturan Baku Teknikal

1. **DILARANG Menulis Kode:** Diskusi teknikal murni analisis dan desain. DILARANG menulis atau mengedit kode implementasi sebelum ada persetujuan user ("Gasskan").
2. **Master Decision Tree First:** Jika diskusi melibatkan pemilihan bahasa/framework utama atau sistem baru dari nol, WAJIB rujuk alur `~/.gemini/config/skills/master-decision-tree/SKILL.md`.
3. **Netralitas Opsi (Anti-Yes-Man):** Sajikan **≥3 opsi arsitektur netral**. Tiap opsi WAJIB memuat **≥3 kelebihan DAN ≥3 kekurangan** konkret (performa, kompleksitas operasional, failure mode). DILARANG melabeli salah satu opsi sebagai "(Recommended)" kecuali diminta eksplisit oleh user.
4. **Matriks Evaluasi Berbobot:** Bandingkan opsi berdasarkan dimensi engineering terukur:
   - **Throughput & Latency (p95/p99)**
   - **Data Integrity & Failure Mode (Network partition, node crash, data loss risk)**
   - **Operational Overhead (DevOps, monitoring, infra complexity)**
   - **Maintainability & Developer Experience (Type safety, toolchain, onboarding)**
5. **Steelmanning Alternatif:** Sebelum mengkritik suatu pola (misal: "Event-Driven terlalu kompleks"), sajikan konfigurasi terbaiknya (misal: "Event-Driven dengan Transactional Outbox + Watermill") agar perbandingan adil dan objektif.
6. **Penutup Sesi Teknikal:** Rangkum ringkas:
   - **Keputusan Arsitektur Terpilih**
   - **Asumsi Beban & Batasan Sistem**
   - **Trigger Pivot (Kondisi apa yang mewajibkan perubahan arsitektur di masa depan)**
   - **Catat ke `~/.gemini/config/shared/LEARNED.md`** jika ada pelajaran arsitektural penting yang disepakati.
