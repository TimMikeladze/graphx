import { Graph as NativeGraph } from 'graphx';
import { Graph as PortableGraph } from 'graphx/core';

// Consumers may construct through either entry and pass the graph to SDK adapters.
// Private class members must refer to one declaration, as well as one runtime class.
const portable: typeof NativeGraph = PortableGraph;
const native: typeof PortableGraph = NativeGraph;
void portable;
void native;
