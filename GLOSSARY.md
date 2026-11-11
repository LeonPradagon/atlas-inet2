# Network Inventory

Terms used to describe imported network cables, optical fibres, and their physical connections.

## Cable and core records

**Cable segment**:
A mapped cable span represented by one line, with ends A and B determined by the line's coordinate order.
_Avoid_: Cable direction, when referring to A/B; A/B is map orientation, not optical signal direction.

**Core**:
One numbered optical fibre strand within a cable segment.
_Avoid_: Tube; a tube can contain multiple cores.

**Core end**:
One physical end of a core in a cable segment, identified as end A or end B.
_Avoid_: Direction; an end label does not mean transmit or receive.

**Mid-span access**:
A point along a cable route where a closure or other access asset allows one or more cores to be spliced or terminated without treating that point as a third cable end. The location is measured from end A and may occur more than once along a route.
_Avoid_: End R; R describes a connection location along the route, not another physical cable end.

**Core status**:
The operational allocation of a core: available, booked, or used.
_Avoid_: Connection; allocation and physical connectivity are separate facts.

## Physical connectivity

**Splice**:
A physical connection joining one core end to another core end at a network asset such as a closure.
_Avoid_: Nearby asset; proximity alone does not establish a splice.

**Termination**:
A core end that ends at a network asset rather than continuing to another cable core.
_Avoid_: Splice, when no second core end is connected.

**Connection candidate**:
An asset suggested by cable geometry for a surveyor to confirm; it is not an established connection.
_Avoid_: Actual endpoint, until confirmed.

**Cable endpoint**:
The network asset recorded at one end of a cable segment. A nearby asset can be suggested automatically, but proximity alone does not confirm the endpoint.
_Avoid_: Core connection; an endpoint identifies the shared physical location, while a core connection identifies what a particular fibre end is joined to there.

**Core connection**:
The recorded attachment for one numbered core at an end or at a mid-span access location: a splice to another cable core, a termination at the network asset, or a device port.
_Avoid_: Core status; a core can be marked available or used independently of whether its physical connection has been recorded.
