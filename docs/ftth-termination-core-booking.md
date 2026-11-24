# FTTH termination and core booking

## Physical fibers and cable identity

In this inventory example, **core** means one assignable optical fiber in a cable. Key it by cable ID and fiber number, and record the tube and fiber markings used in the field. Corning's 96-fiber OS2 ADSS example has eight active buffer tubes with 12 fibers per tube. If the cable schedule numbers those tubes and fibers in order, tube 1 holds fibers 01–12, tube 2 holds 13–24, and tube 8 holds 85–96. Confirm the numbering and color sequence against the installed cable's datasheet and as-built schedule. [Corning 096EAE-T4B01A20 cable specifications](https://ecatalog.corning.com/optical-communications/CALA/en/Fiber-Optic-Cables/Outdoor/Outdoor-Aerial-Cables/SOLO%C2%AE-ADSS-Loose-Tube%2C-Gel-Filled%2C-Dual-Jacket-Cable/p/096EAE-T4B01A20)

## Continuity, splices, and terminations

- **Express continuity.** At a midspan closure, a fiber can pass through uncut. Map both route spans to the same physical cable and fiber where the as-built confirms an uncut run. [Corning splice closure and express-port documentation](https://www.corning.com/optical-communications/worldwide/en/home/products/fiber-optic-cable-and-closure-solutions.html)
- **Splice continuity.** Where separate fiber ends meet, record the exact pair and the closure and tray position. A splice can join different fiber numbers across cable IDs. Matching numbers alone give no evidence of a connection. ITU-T specifies fusion and mechanical splices and their performance criteria. [ITU-T L.400/L.12, Optical fibre splices](https://www.itu.int/rec/T-REC-L.400)
- **Connector termination.** A fiber can be fusion-spliced to a connectorized pigtail. Record the fiber-to-port mapping and any patch connection required to continue the path. A closure can contain express fibers, splices, and terminations at the same location. [Corning pigtail termination example](https://www.corning.com/media/worldwide/coc/documents/applications/wireless/wireless-specs/SD-LAN-Access-Node-Quick-Installation-Guide.pdf) · [ITU-T L.250, Topologies for optical access network](https://www.itu.int/epublications/publication/itu-t-l-250-2024-01-topologies-for-optical-access-network)

## Passive splitters

A GPON optical distribution network can connect one OLT port to multiple ONTs through a passive splitter. A 1×8 unit has one common port and eight branch ports. Book the upstream fiber once as the shared PON feeder, then book each assigned output port and its downstream fiber path. Separate output-port availability from cable availability. Verify the optical budget for each OLT-to-ONT path using the installed splitter's insertion-loss specification and the losses of fiber, splices, and connectors. [ITU-T G.984.1, Figure 2](https://www.itu.int/rec/dologin_pub.asp?id=T-REC-G.984.1-200803-I%21%21PDF-E&lang=f&type=items) · [CommScope 1×8 single-mode splitter specification](https://www.commscope.com/product-type/hubs-closures-terminals-boxes/fiber-closures/fiber-splitterwdm-components/item760263888/)

## Worked A–B–C–D–E examples using 96-fiber cable

The assignments below are illustrative. Each span has 96 fibers. A–B and B–C are two route spans of the same cable X, which passes through B. C–D is cable Y, and D–E is cable Z. Assume all unspecified fibers begin unassigned.

| Location | Point-to-point circuit P1 | PON group G1 serving one ONT at E |
| --- | --- | --- |
| A | Terminate X:01 at an A panel port | Connect the OLT port to X:02 |
| B | Express X:01 uncut | Express X:02 uncut |
| C | Splice X:01 to Y:17 | Connect X:02 to splitter S1 common port. Connect S1 output 3 to Y:18 |
| D | Splice Y:17 to Z:17 | Splice Y:18 to Z:29 |
| E | Terminate Z:17 at an E panel port | Connect Z:29 to the ONT |

- **P1 booking.** Assign X:01, Y:17, and Z:17 to P1. X:01 appears on two route spans but is one physical cable-fiber assignment. Y:01 remains unassigned in this example.
- **G1 booking.** Assign X:02 to G1's shared feeder, and assign S1 output 3, Y:18, and Z:29 to the E branch. S1 outputs 1–2 and 4–8 remain unassigned. Another branch on output 4 can share X:02 and needs its own verified downstream path. An unused output alone supplies no downstream fiber capacity.
- **Capacity after both bookings.** A–B and B–C each have 94 unassigned fibers (X:03–96). C–D has 94 (Y:01–16 and Y:19–96). D–E has 94 (Z:01–16, Z:18–28, and Z:30–96). These are local inventory counts. A new A-to-E booking needs a trace through actual express continuity, splices, or port connections at every intermediate node.
- **Full-span allocation example.** If all 96 fibers of Y are assigned or reserved, a new circuit that needs a dedicated Y fiber is blocked even when X and Z have spare fibers. Count assigned and reserved resources separately, and confirm the splice or port path before booking an unassigned fiber.

For field reconciliation, capture the cable and fiber IDs on each side of a closure, the connection type, the relevant tray or port, and the test reference. Confirm endpoint identity and continuity before treating a route as usable. Use loss measurements for acceptance and a PON-capable OTDR where event-level diagnosis through a splitter is required. [EXFO, OTDR PON testing](https://www.exfo.com/contentassets/d407e533bf304cf8a8d635f389a1bc3a/exfo_anote201_otdr-pon-testing_en.pdf)
