# SeaORM: ActiveModel & Entity Relations

## Konsep Utama
**SeaORM** adalah ORM asinkron untuk Rust yang didasarkan pada konsep Active Record / Data Mapper dan dibangun di atas `sqlx`. Konsep kuncinya adalah **Entity** (Representasi skema tabel) dan **ActiveModel**. 

`ActiveModel` memisahkan antara state *terbaca (Read)* dari database dan state *untuk ditulis (Write)*. Hal ini dimungkinkan melalui wrapper `ActiveValue` (`Set`, `Unchanged`, `NotSet`) yang secara cerdas mendeteksi *kolom mana* yang dimodifikasi (partial update) alih-alih me-replace seluruh kolom saat operasi `UPDATE`.

**Kapan Digunakan:**
- CRUD logic kompleks yang lebih bersih ditulis dengan Query Builder dibandingkan raw SQL.
- Validasi data internal struct sebelum masuk database (Trait hooks di ActiveModel).
- Eager/Lazy loading relations (One-to-Many / Many-to-Many).

## Arsitektur & Flow

```ascii
+-------------+       .into_active_model()      +-----------------+
| Model       |-------------------------------->| ActiveModel     |
| (Read-Only) |                                 | username: Set() |
+-------------+                                 | id: Unchanged() |
                                                +-------+---------+
                                                        |
                                                        v .update(db)
+-------------+         Generated SQL           +-----------------+
| DB Table    | <-------------------------------| UPDATE users SET|
| 'users'     |                                 | username = '..' |
+-------------+                                 +-----------------+
```

## Production-Ready Code

```rust
use sea_orm::{
    entity::prelude::*,
    ActiveValue::{Set, NotSet, Unchanged},
    QuerySelect, RelationTrait,
};
use sea_orm::ActiveValue;

// ---- BEGIN ENTITY BOILERPLATE (biasanya di-generate sea-orm-cli) ----
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "users")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub username: String,
    pub status: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::post::Entity")]
    Post,
}

impl ActiveModelBehavior for ActiveModel {
    // Hooks eksekusi logic sebelum di save ke DB
    fn before_save(mut self, _insert: bool) -> Result<Self, DbErr> {
        // Contoh: kapitalisasi username sebelum save
        if let ActiveValue::Set(name) = &mut self.username {
            *name = name.to_uppercase();
        }
        Ok(self)
    }
}
// ---- END ENTITY BOILERPLATE ----

// Stub post entity for relational demo
pub mod post {
    use sea_orm::entity::prelude::*;
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "posts")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub user_id: i32,
        pub title: String,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::Entity",
            from = "Column::UserId",
            to = "super::Column::Id"
        )]
        User,
    }
    impl ActiveModelBehavior for ActiveModel {}
}

// 1. Partial Update menggunakan ActiveModel
pub async fn update_user_status(
    db: &DatabaseConnection,
    user_id: i32,
    new_status: &str,
) -> Result<Model, DbErr> {
    // Instansiasi ActiveModel HANYA dengan PK dan kolom yang mau diupdate
    // Tanpa melakukan pre-fetching data SELECT terlebih dahulu
    let partial_update = ActiveModel {
        id: Set(user_id),
        status: Set(new_status.to_string()),
        ..Default::default() // Sisanya NotSet
    };

    // Ini akan menjalankan: UPDATE users SET status='...' WHERE id = X
    let updated_model: Model = partial_update.update(db).await?;
    Ok(updated_model)
}

// 2. Mengatasi N+1 Problem (Eager loading)
pub async fn get_users_with_posts(db: &DatabaseConnection) -> Result<Vec<(Model, Vec<post::Model>)>, DbErr> {
    // find_with_related mengatasi N+1 query dgn melakukan JOIN / 2 queries pintar
    let results = Entity::find()
        .find_with_related(post::Entity)
        .all(db)
        .await?;
    Ok(results)
}
```

## Anti-Patterns

1. **Membaca Keseluruhan Baris (SELECT) Hanya Untuk Melakukan Single-Column Update**
   - **MENGAPA BERBAHAYA:** Developer sering melakukan `let mut user = Entity::find_by_id(1).one(db).await?; user.status = Set("A"); user.update(db);`. Ini menghasilkan overhead 2 query (Read & Write) padahal yang diperlukan hanya 1 query Write. Selalu langsung instansiasi `ActiveModel` menggunakan trait PK `Set(id)` untuk *blind update*.
2. **N+1 Query Issue Terabaikan dalam Looping**
   - **MENGAPA BERBAHAYA:** Mengambil List data (misal list User), kemudian me-loop array result-nya, dan memanggil `post::Entity::find().filter(user_id).one()` *di dalam* loop. Ini adalah jebakan klasik performa ORM. Selalu gunakan `find_also_related`, `find_with_related`, atau query loader bawaan SeaORM (Dataloader pattern).

## Edge Context & Defensive Programming
- **ActiveValue::NotSet vs ActiveValue::Unchanged:** `NotSet` berarti kolom tersebut akan sepenuhnya dihiraukan saat generate SQL (berguna untuk default DB constraint/autoincrement). `Unchanged` artinya nilainya sudah disinkronisasi dengan DB dan dipertahankan jika modifikasi terjadi di memori namun kita tidak ingin merender ulang SQL update-nya pada kolom itu. Pahami perbedaannya agar tidak tidak sengaja me-null-kan / override kolom penting.
- **Custom SELECT SQL:** SeaORM bagus untuk 80% CRUD standar. Namun pada analytical queries yang kompleks, SeaORM statement builder bisa jadi sangat lambat dicompile atau sulit dibaca strukturnya. SeaORM mendukung `.from_raw_sql("...")` via `Statement` fallback jika Anda menyadari query builder terlalu kompleks.
