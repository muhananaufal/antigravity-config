---
name: templates
description: Gunakan skill ini ketika menulis atau memperbarui artefak baku proyek — implementation_plan.md, system_map.md, task.md, laporan hasil test, atau Side Note. Berisi kerangka wajib tiap artefak beserta aturan pengisiannya.
---

# Template Artefak

Kerangka di bawah WAJIB diikuti persis. §5 `AGENTS.md` menunjuk ke sini.

## `implementation_plan.md`

```markdown
# <Judul>
## Konteks        <!-- masalah yang dipecahkan + kenapa sekarang -->
## Opsi           <!-- ≥3 opsi netral, tiap opsi ≥3 kelebihan & ≥3 kekurangan -->
## Rencana        <!-- langkah eksekusi + berkas yang disentuh -->
## Verifikasi     <!-- perintah test yang akan dijalankan + kriteria lulus -->
## Risiko & Rollback
```

Asumsi hasil Gerbang Klarifikasi (§2) WAJIB ditulis terbuka di bagian **Konteks**. DILARANG menyimpannya di kepala.

## `system_map.md`

```markdown
# System Map
## Stack          <!-- bahasa, framework, DB, cache, broker + versi -->
## Modul          <!-- tabel: modul | tanggung jawab | path | depends-on -->
## Alur Kritis    <!-- request masuk s/d respons, sebut berkas per langkah -->
## Kontrak Eksternal  <!-- API, event, tabel DB yang dipakai pihak lain -->
## Utang Teknis   <!-- diketahui tapi belum diperbaiki + alasannya -->
<!-- Terakhir diverifikasi: <tanggal> vs commit <sha> -->
```

## `task.md`

```markdown
# Task
- [ ] <belum mulai>
- [/] <sedang dikerjakan — MAKSIMAL 2 baris berstatus ini>
- [x] <selesai & exit gate lulus>
```

## Side Note

Maksimal 2 baris, di AKHIR respon, persis format ini:

```markdown
> Side Note: <temuan> — <dampaknya>. Di luar scope, tidak saya ubah.
```

Dipakai untuk temuan di luar scope, termasuk pelanggaran berlabel `~ PRAADA` dari quality gate. DILARANG memperbaikinya tanpa diminta (§4).

## Laporan hasil test

WAJIB memuat perintah yang dijalankan **dan** outputnya apa adanya. DILARANG mengklaim lulus tanpa menampilkan bukti. Ada yang gagal sejak baseline (§3.3) → sebutkan, dan DILARANG dihitung sebagai kerusakan Anda.
