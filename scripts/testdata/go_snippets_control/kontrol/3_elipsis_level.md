# Kontrol Elipsis & Level

## E1 SAH - parameter variadik (harus PARSE_OK, BUKAN ELISION)

```go
func Logf(format string, args ...interface{}) {
	fmt.Printf(format, args...)
}
```

## E2 SAH - spread argumen (harus PARSE_OK)

```go
parts := []string{"a", "b"}
joined := filepath.Join(parts...)
```

## E3 SAH - array berukuran inferensi (harus PARSE_OK)

```go
var codes = [...]int{200, 404, 500}
```

## E4 ELIPSIS - singkatan di tengah argumen (harus ELISION)

```go
secret, _ := smClient.GetSecretValue(ctx, ...)
db := connect(secret)
```

## E5 ELIPSIS - singkatan di baris sendiri (harus ELISION)

```go
type Server struct {
	Addr string
	...
}
```

## E6 LEVEL CAMPUR - statement dan deklarasi func dalam satu fence (harus MIXED_LEVEL)

```go
ctx = context.WithValue(ctx, "db_conn", pool)
func getUser(ctx context.Context) {
	db := ctx.Value("db_conn").(*sql.DB)
}
```

## E7 SALAH BENERAN - tetap harus PARSE_FAIL

```go
func Rusak(a int) int {
	if a > 0 {
		return a
	return 0
}
```