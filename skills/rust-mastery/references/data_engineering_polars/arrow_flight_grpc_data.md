# Arrow Flight gRPC Protocol

## Konsep Utama
Apache Arrow Flight adalah protokol klien-server berkinerja tinggi berbasis gRPC yang dioptimalkan untuk transportasi data massal. Alih-alih mentransfer data analitik lewat JSON/REST HTTP atau CSV di mana CPU sibuk melakukan *Serialization/Deserialization* (SerDe), Arrow Flight mentransfer Arrow RecordBatches *sebagaimana adanya* dalam bentuk buffer biner. Ini mewujudkan konsep *Zero-Copy* over network.

## Arsitektur & Flow
```text
[ Data Server (FlightService) ]
       |
    1. GetFlightInfo (Client meminta metadata)
    2. Server membalas dengan Schema dan FlightEndpoints (Lokasi data, Tickets)
       |
    3. DoGet(Ticket) (Client meminta stream data)
       |
[ Stream of gRPC Messages (Arrow IPC payload) ] -> ( Zero SerDe Overhead! )
       |
[ Client (Polars / Pandas / DataFusion) ]
```

## Production-Ready Code
```rust
use std::pin::Pin;
use arrow_flight::{
    flight_service_server::{FlightService, FlightServiceServer},
    Action, ActionType, Criteria, Empty, FlightData, FlightDescriptor, FlightInfo,
    HandshakeRequest, HandshakeResponse, PutResult, SchemaAsIpc, SchemaResult, Ticket,
};
use arrow_ipc::writer::{DictionaryTracker, IpcDataGenerator, IpcWriteOptions};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::array::Int32Array;
use tonic::{Request, Response, Status, Streaming};
use futures::Stream;
use std::sync::Arc;

#[derive(Clone)]
pub struct MyFlightServer {}

#[tonic::async_trait]
impl FlightService for MyFlightServer {
    type HandshakeStream = Pin<Box<dyn Stream<Item = Result<HandshakeResponse, Status>> + Send + Sync + 'static>>;
    type ListFlightsStream = Pin<Box<dyn Stream<Item = Result<FlightInfo, Status>> + Send + Sync + 'static>>;
    type DoGetStream = Pin<Box<dyn Stream<Item = Result<FlightData, Status>> + Send + Sync + 'static>>;
    type DoPutStream = Pin<Box<dyn Stream<Item = Result<PutResult, Status>> + Send + Sync + 'static>>;
    type DoExchangeStream = Pin<Box<dyn Stream<Item = Result<FlightData, Status>> + Send + Sync + 'static>>;
    type DoActionStream = Pin<Box<dyn Stream<Item = Result<arrow_flight::Result, Status>> + Send + Sync + 'static>>;
    type ListActionsStream = Pin<Box<dyn Stream<Item = Result<ActionType, Status>> + Send + Sync + 'static>>;

    async fn get_flight_info(
        &self,
        request: Request<FlightDescriptor>,
    ) -> Result<Response<FlightInfo>, Status> {
        let desc = request.into_inner();
        
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
        ]));
        
        let options = IpcWriteOptions::default();
        let schema_flight_data: FlightData = SchemaAsIpc::new(&schema, &options).into();

        let endpoint = arrow_flight::FlightEndpoint {
            ticket: Some(Ticket { ticket: b"query_123".to_vec() }),
            location: vec![], // Biarkan klien konek ke endpoint yang sama
        };

        let info = FlightInfo {
            schema: schema_flight_data.data_header,
            flight_descriptor: Some(desc),
            endpoint: vec![endpoint],
            total_records: 100,
            total_bytes: -1, // Unknown
            ordered: false,
            app_metadata: vec![],
        };

        Ok(Response::new(info))
    }

    async fn do_get(
        &self,
        request: Request<Ticket>,
    ) -> Result<Response<Self::DoGetStream>, Status> {
        let ticket = request.into_inner();
        
        if ticket.ticket != b"query_123" {
            return Err(Status::not_found("Ticket tidak valid"));
        }

        // Generate data dummy
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let id_array = Int32Array::from(vec![1, 2, 3, 4, 5]);
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(id_array)]).unwrap();

        // Arrow IPC Encoder
        let options = IpcWriteOptions::default();
        let mut dictionary_tracker = DictionaryTracker::new(false);
        let data_gen = IpcDataGenerator::default();

        let (_dict_flight_data, batch_flight_data) = data_gen.record_batch_to_flight_data(
            &batch,
            &options,
            &mut dictionary_tracker,
        ).expect("Gagal encode batch");
        
        let schema_flight_data: FlightData = SchemaAsIpc::new(&schema, &options).into();

        // Kumpulkan hasil stream
        let flights = vec![
            Ok(schema_flight_data),
            Ok(batch_flight_data)
        ];

        let output = futures::stream::iter(flights);
        Ok(Response::new(Box::pin(output)))
    }

    // Unimplemented methods sengaja di-skip di example ini untuk brevity
    async fn handshake(&self, _r: Request<Streaming<HandshakeRequest>>) -> Result<Response<Self::HandshakeStream>, Status> { Err(Status::unimplemented("")) }
    async fn list_flights(&self, _r: Request<Criteria>) -> Result<Response<Self::ListFlightsStream>, Status> { Err(Status::unimplemented("")) }
    async fn get_schema(&self, _r: Request<FlightDescriptor>) -> Result<Response<SchemaResult>, Status> { Err(Status::unimplemented("")) }
    async fn do_put(&self, _r: Request<Streaming<FlightData>>) -> Result<Response<Self::DoPutStream>, Status> { Err(Status::unimplemented("")) }
    async fn do_exchange(&self, _r: Request<Streaming<FlightData>>) -> Result<Response<Self::DoExchangeStream>, Status> { Err(Status::unimplemented("")) }
    async fn do_action(&self, _r: Request<Action>) -> Result<Response<Self::DoActionStream>, Status> { Err(Status::unimplemented("")) }
    async fn list_actions(&self, _r: Request<Empty>) -> Result<Response<Self::ListActionsStream>, Status> { Err(Status::unimplemented("")) }
}
```

## Anti-Patterns

1. **Lupa Mengirim Header Schema pada DoGet**
   - *Mengapa berbahaya:* Protokol Flight mengharuskan pesan pertama pada stream balasan `DoGet` adalah payload metadata Schema (dihasilkan via `SchemaAsIpc`). Jika klien langsung menerima `RecordBatch`, klien akan gagal melakukan decode karena tidak tahu tipe kolom.
   - *Solusi:* Pastikan elemen pertama stream selalu `SchemaFlightData` seperti dalam contoh `vec![Ok(schema_flight_data), Ok(batch_flight_data)]`.

2. **Gagal Mendukung Dictionaries Tracker**
   - *Mengapa berbahaya:* Arrow IPC memiliki struktur mutasi dictionary. Jika Anda tidak me-maintain object state `DictionaryTracker` yang sama selama perputaran Stream (untuk batch yang beruntun), dictionary keys akan tidak match (corrupted).
   - *Solusi:* Instansiasi `DictionaryTracker` satu kali di luar loop stream dan pinjamkan secara mutable ke pemanggilan encode selanjutnya.

## Edge Cases & Defensive Programming
- **gRPC Message Size Limit:** Default gRPC max message size biasanya hanya 4MB. Jika buffer 1 RecordBatch melebihi ini, DoGet akan putus dengan *ResourceExhausted*. Di konfigurasi tonic `.max_decoding_message_size()`, tingkatkan batasnya menjadi ratusan MB agar zero-copy stream berjalan optimal.
- **Flight Endpoints Lokasi Kosong:** Seperti di kode, `location` array kosong artinya klien menggunakan koneksi gRPC eksisting untuk fetching ticket. Jika Anda menjalankan arsitektur terdistribusi (Distributed Query Engine), Server 1 (Planner) bisa me-return Ticket dengan Location ke IP Worker Node untuk paralelisasi DoGet.
