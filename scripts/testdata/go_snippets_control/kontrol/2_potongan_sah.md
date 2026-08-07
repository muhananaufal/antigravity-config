# Kontrol Lanjutan

## S1 SAH - potongan badan switch (harus PARSE_OK)

```go
case "a":
	return 1
case "b":
	return 2
default:
	return 0
```

## S2 SAH - cabang select (harus PARSE_OK)

```go
case <-ctx.Done():
	return ctx.Err()
case v := <-ch:
	process(v)
```

## S3 SAH - daftar field struct (harus PARSE_OK)

```go
Name    string `json:"name"`
Age     int    `json:"age"`
Created time.Time
```

## S4 SAH - method interface (harus PARSE_OK)

```go
Save(ctx context.Context, u *User) error
FindByID(ctx context.Context, id string) (*User, error)
```

## S5 SALAH TAG - shell di dalam fence go (harus MIXED_FENCE)

```go
# pasang alat
go install honnef.co/go/tools/cmd/staticcheck@latest
$ staticcheck ./...
```

## S6 SALAH TAG - SQL di dalam fence go (harus MIXED_FENCE)

```go
-- indeks penutup
CREATE INDEX idx_users_email ON users(email);
SELECT * FROM users WHERE email = $1;
```

## S7 SALAH BENERAN - kurawal menggantung (harus tetap PARSE_FAIL)

```go
func Tetap(a int) int {
	if a > 0 {
		return a
	return 0
}
```

## S8 SAH - potongan statement biasa (harus PARSE_OK)

```go
db, err := sql.Open("pgx", dsn)
if err != nil {
	return nil, err
}
```