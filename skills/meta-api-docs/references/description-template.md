<!--
Template deskripsi satu endpoint. Simpan sebagai
docs/postman/descriptions/{nn-grup}/{slug nama request}.md.
Hapus baris tabel yang tidak berlaku; jangan tulis klaim yang belum diverifikasi ke kode.
-->
{Satu kalimat: apa yang dilakukan endpoint ini, untuk siapa.}

| Akses | |
| :--- | :--- |
| Autentikasi | Bearer token + akun aktif |
| Izin | `modul>aksi` |
| Kepemilikan / cakupan | {Pemilik data, atau role lintas-kepemilikan; siapa melihat apa} |
| Throttle | {n request per menit, bila ada} |
| Content-Type | `application/json` / `multipart/form-data` |

#### Body / Query

| Field | Tipe | Wajib | Aturan |
| :--- | :--- | :---: | :--- |
| `field` | string | ✓ | {dari rules() / withValidator} |
| `field_lain` | angka | | {diabaikan untuk role X, bila begitu} |

#### Aturan bisnis

1. {Status yang boleh → selain itu 422 "pesan asli".}
2. {Perhitungan / kuota / batas → kode + pesan.}
3. {Beda per role: role A ..., role B ...}
4. {Konkurensi: kunci per ... → 429; keputusan bertabrakan → 409.}
5. {Efek samping: notifikasi, saldo, file.}

#### Respons

| Status | Kapan |
| :---: | :--- |
| 200 | {pesan sukses asli}; `data` = {resource} |
| 401 | Token tidak ada / salah, atau akun nonaktif |
| 403 | {izin / kepemilikan} |
| 404 | Id tidak ada |
| 409 | {bila ada} |
| 422 | {validasi + aturan bisnis} |
| 429 | {bila ada kunci / throttle} |
