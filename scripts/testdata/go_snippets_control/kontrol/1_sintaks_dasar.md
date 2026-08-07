# Korpus Kontrol

## 1. BENAR - program mandiri (harus PARSE_OK, BUILD_OK)

```go
package main

import "fmt"

func main() {
	fmt.Println("halo")
}
```

## 2. BENAR - potongan deklarasi tanpa header package (harus PARSE_OK)

```go
func Sum(a, b int) int {
	return a + b
}
```

## 3. BENAR - potongan statement di dalam fungsi (harus PARSE_OK)

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
```

## 4. SALAH - kurung kurawal tidak tertutup (harus PARSE_FAIL)

```go
func Broken(a int) int {
	if a > 0 {
		return a
	return 0
}
```

## 5. SALAH - typo keyword (harus PARSE_FAIL)

```go
fnc Salah() {
	return
}
```

## 6. SAH - elipsis struktural (harus PARSE_ELISION, bukan FAIL)

```go
type Server struct {
	...
}
```

## 7. Bukan Go - fence bash, harus DIABAIKAN total

```bash
go build ./... && echo ok
```

## 8. BENAR - program mandiri yang butuh dependensi eksternal (BUILD_EXTDEP, bukan BUILD_FAIL)

```go
package main

import "github.com/tidak/ada/sama/sekali"

func main() {
	sekali.Jalan()
}
```

## 9. SALAH SEMANTIK - parse lolos tapi build gagal (harus BUILD_FAIL)

```go
package main

import "fmt"

func main() {
	var x int = "ini string, bukan int"
	fmt.Println(x)
}
```