# Kontrol Fence Campur Tanpa Penanda Prompt

## C1 SALAH TAG - perintah terminal tanpa "#" atau "$" (harus MIXED_FENCE)

```go
go test -bench=. -count=10 | tee result.txt
benchstat result.txt
```

## C2 SAH - "go" sebagai statement Go beneran (harus PARSE_OK, BUKAN MIXED_FENCE)

```go
go handleConnection(conn)
go func() {
	defer wg.Done()
	worker(ctx, jobs)
}()
```

## C3 SAH - pemanggilan berflag di dalam string, bukan perintah shell (harus PARSE_OK)

```go
cmd := exec.CommandContext(ctx, "go", "test", "-race", "./...")
out, err := cmd.CombinedOutput()
```