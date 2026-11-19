import type {
  OpenAPIObject,
  OperationObject,
  SchemaObject,
} from "@nestjs/swagger";

// These schemas describe the stable fields returned by the controllers. JSON
// imported from KMZ, analysis providers, and saved plans remains extensible.
const string: SchemaObject = { type: "string" };
const number: SchemaObject = { type: "number" };
const integer: SchemaObject = { type: "integer" };
const boolean: SchemaObject = { type: "boolean" };
const dynamic: SchemaObject = { type: "object", additionalProperties: true };
const nullableString: SchemaObject = { type: "string", nullable: true };
const nullableNumber: SchemaObject = { type: "number", nullable: true };
const decimal: SchemaObject = {
  oneOf: [{ type: "number" }, { type: "string" }],
};
const nullableDecimal: SchemaObject = {
  oneOf: [number, string],
  nullable: true,
};
const list = (items: SchemaObject): SchemaObject => ({ type: "array", items });
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({
  type: "object",
  properties,
});
const nullableObject: SchemaObject = { ...dynamic, nullable: true };
const id = object({ id: string });
const coords = list(number);
const bounds = { ...coords, nullable: true };
const geometry = object({
  type: string,
  coordinates: { type: "array", items: {} },
});
const region = object({ code: string, name: string });
const user = object({ id: string, name: string, email: string, role: string });
const segment = object({
  segmentId: string,
  cores: integer,
  segmentFrom: string,
  segmentTo: string,
  name: string,
  area: string,
});
const booking = object({
  id: string,
  segmentId: string,
  segmentName: string,
  area: string,
  customer: string,
  cores: integer,
  picCustomer: string,
  picCustomerEmail: string,
  picCustomerPhone: string,
  picPresales: string,
  status: string,
  requestedBy: nullableString,
  requestedAt: nullableString,
  approvedAt: nullableString,
  rejectedAt: nullableString,
  expiresAt: nullableString,
  segments: list(segment),
});
const asset = object({
  id: string,
  name: string,
  area: string,
  assetType: string,
  source: string,
  cableType: string,
  installation: string,
  side: string,
  pole: string,
  poleHeight: nullableString,
  odc: string,
  odp: string,
  totalCores: integer,
  usedCores: integer,
  bookedCores: integer,
  idleCores: integer,
  geometryType: string,
  geometry: { ...geometry, nullable: true },
  attributes: dynamic,
  createdAt: string,
  nameValid: boolean,
});
const core = object({
  coreNumber: integer,
  status: string,
  endA: nullableObject,
  endB: nullableObject,
  midspanConnections: list(dynamic),
  bookingId: nullableString,
  customer: nullableString,
  picCustomer: nullableString,
  picPresales: nullableString,
  expiresAt: nullableString,
  legacyConnectedAssetId: nullableString,
  legacyConnectedSide: nullableString,
  legacyConnectedAssetName: nullableString,
});
const destination = object({
  id: string,
  name: string,
  type: nullableString,
  side: string,
  distanceFromEndpoint: decimal,
  distanceToRoute: decimal,
  longitude: number,
  latitude: number,
  matchesDistribution: boolean,
  matchesCompany: boolean,
});
const relation = object({
  assetId: string,
  kind: string,
  name: string,
  area: string,
  poleHeight: nullableString,
});
const route = object({
  distanceMeters: number,
  durationSeconds: number,
  geometry,
  roadClasses: list(nullableString),
});
const analysis = object({
  address: string,
  status: string,
  latitude: number,
  longitude: number,
  distanceMeters: nullableNumber,
  geocodingMatch: string,
  geocodingProvider: string,
  matchedStreet: string,
  network: nullableObject,
  routes: list(dynamic),
  routeGeometry: geometry,
  proposal: dynamic,
  terminationPlan: dynamic,
  terminations: dynamic,
  message: string,
  expansionAvailable: boolean,
  searchRadiusMeters: number,
  historyId: string,
});
const connectionAnalysis = object({
  address: string,
  status: string,
  mode: string,
  inputMode: string,
  start: dynamic,
  end: dynamic,
  source: nullableObject,
  destination: nullableObject,
  network: nullableObject,
  routes: list(dynamic),
  terminationPlan: nullableObject,
  message: string,
  searchRadiusMeters: number,
  terminalToleranceMeters: number,
  historyId: string,
});
const job = object({
  jobId: string,
  historyId: string,
  fileName: string,
  status: string,
  total: integer,
  processed: integer,
  succeeded: integer,
  failed: integer,
  cancelRequested: boolean,
  createdAt: string,
  updatedAt: string,
  savedDraftRows: list(integer),
});
const row = object({
  row: integer,
  address: nullableString,
  latitude: nullableNumber,
  longitude: nullableNumber,
  status: string,
  message: nullableString,
  network: nullableObject,
  distanceMeters: nullableNumber,
  result: nullableObject,
});
const history = object({
  id: string,
  analysisType: string,
  title: string,
  status: nullableString,
  itemCount: integer,
  locationSummary: nullableString,
  networkName: nullableString,
  createdAt: string,
  bulkJobId: nullableString,
  jobStatus: nullableString,
  processedRows: nullableNumber,
  succeededRows: nullableNumber,
  failedRows: nullableNumber,
  input: dynamic,
  result: dynamic,
  relatedDrafts: list(dynamic),
});
const page = (key: "items" | "rows", item: SchemaObject) =>
  object({
    [key]: list(item),
    page: integer,
    pageSize: integer,
    total: integer,
  });
const survey = object({
  id: string,
  history_id: string,
  row_number: integer,
  address: string,
  analysis: dynamic,
  status: string,
  requested_by: string,
  requester: nullableString,
  findings: dynamic,
  verified_at: nullableString,
  verified_by: nullableString,
  updated_at: string,
});
const status = object({ id: string, status: string });
const pattern = object({ pattern: string });
const duration = object({ days: integer });
const error = object({
  statusCode: integer,
  message: { oneOf: [string, list(string)] },
  error: string,
  code: string,
});

const schemas: Record<string, SchemaObject> = {
  HealthController_health: object({
    database: string,
    photon: object({ status: string, details: dynamic }),
    routing: string,
    status: string,
  }),
  BookingController_bookableSegments: list(
    object({
      id: string,
      name: string,
      area: string,
      assetType: string,
      totalCores: integer,
      idleCores: integer,
      usedCores: integer,
      bookedCores: integer,
      attributes: dynamic,
      ends: nullableObject,
      endpointNames: nullableObject,
      nearbyEndpointNames: nullableObject,
    })
  ),
  BookingController_bookings: list(booking),
  BookingController_createBooking: object({
    id: string,
    cores: integer,
    customer: string,
    picCustomer: string,
    picPresales: string,
    segmentId: string,
    status: string,
  }),
  BookingController_approveBooking: object({
    id: string,
    status: string,
    allocatedBookingIds: list(string),
  }),
  BookingController_rejectBooking: status,
  BookingController_releaseBooking: object({
    released: string,
    allocated: nullableString,
    allocatedBookingIds: list(string),
  }),
  BookingController_resubmitBooking: status,
  BookingController_purchaseOrderIssued: status,
  BookingController_duration: duration,
  BookingController_setDuration: duration,
  AtlasController_dashboard: object({
    segments: integer,
    totalCores: integer,
    usedCores: integer,
    bookedCores: integer,
    waitingCount: integer,
    recentBookings: list(booking),
    companyCount: integer,
    companies: list(object({
      value: string,
      name: string,
      segmentCount: integer,
      lengthMeters: number,
    })),
    companySummary: object({
      segmentCount: integer,
      lengthMeters: number,
      provinceCount: integer,
      areaCount: integer,
      totalCores: integer,
      verifiedCores: integer,
      unverifiedCores: integer,
      usedCores: integer,
      bookedCores: integer,
      idleCores: integer,
    }),
    regions: list(object({
      area: string,
      province: string,
      segmentCount: integer,
      lengthMeters: number,
    })),
    segmentTotal: integer,
    page: integer,
    pageSize: integer,
    segmentItems: list(object({
      id: string,
      name: string,
      area: string,
      province: string,
      cableType: nullableString,
      lengthMeters: number,
      totalCores: integer,
      usedCores: integer,
      bookedCores: integer,
      idleCores: integer,
    })),
  }),
  AtlasController_auditTrails: list(
    object({
      id: string,
      action: string,
      entityType: string,
      entityId: nullableString,
      details: dynamic,
      createdAt: string,
      actorName: nullableString,
      actorEmail: nullableString,
    })
  ),
  AtlasController_networkUsageReport: list(
    object({
      id: string,
      name: string,
      area: string,
      cableType: string,
      totalCores: integer,
      usedCores: integer,
      availableCores: integer,
      bookedCores: integer,
      waitingList: integer,
      installation: string,
      side: string,
      pole: string,
      poleHeight: nullableString,
      odc: string,
      odp: string,
      relatedAssets: list(relation),
    })
  ),
  AtlasController_assets: list(asset),
  AtlasController_assetImports: list(
    object({
      id: string,
      name: string,
      importedCount: integer,
      segmentCount: integer,
      companies: list(string),
      ftthFolderCount: integer,
      folderPaths: list(string),
      createdAt: string,
      actorName: nullableString,
      actorEmail: nullableString,
    })
  ),
  AtlasController_assetCatalog: page("items", asset),
  AtlasController_mapProvinces: object({
    items: list(
      object({
        code: string,
        name: string,
        assetCount: integer,
        folderCount: integer,
        bounds,
      })
    ),
    unassigned: object({ assetCount: integer, folderCount: integer }),
  }),
  AtlasController_mapProvinceBoundaries: object({
    type: { type: "string", enum: ["FeatureCollection"] },
    features: list(
      object({
        type: string,
        geometry,
        properties: object({ provinceCode: string, provinceName: string }),
      })
    ),
  }),
  AtlasController_kmzIcon: object({
    data: { type: "string", format: "byte" },
    mimeType: string,
  }),
  AtlasController_mapBounds: object({ bounds }),
  AtlasController_mapAssets: list(asset),
  AtlasController_createPointAsset: object({
    id: string,
    name: string,
    kind: string,
    area: string,
    longitude: number,
    latitude: number,
    poleHeight: nullableString,
  }),
  AtlasController_saveFtthDesign: object({
    designId: string,
    historyId: string,
    savedCount: integer,
  }),
  AtlasController_assetGeometry: object({
    geometry,
    provinceCode: nullableString,
  }),
  AtlasController_updateAsset: asset,
  AtlasController_cores: list(core),
  AtlasController_coreDestinations: list(destination),
  AtlasController_coreEndpoints: list(
    object({
      side: string,
      endpoint: nullableObject,
      candidates: list(destination),
    })
  ),
  AtlasController_coreRouteNodes: list(
    object({
      id: string,
      name: string,
      type: nullableString,
      routeMeasureM: decimal,
      distanceToRoute: decimal,
      routeLengthM: number,
      matchesDistribution: boolean,
      matchesCompany: boolean,
    })
  ),
  AtlasController_coreConnectionPeers: list(
    object({
      peerSegmentId: string,
      peerSegmentName: string,
      peerSide: string,
      peerRouteMeasureM: nullableDecimal,
      peerCoreNumber: integer,
      peerStatus: string,
      existingConnectionType: nullableString,
      existingPeerCoreId: nullableNumber,
      existingPeerSide: nullableString,
      connectionGroupId: nullableString,
      connectedSegmentId: nullableString,
      connectedCoreNumber: nullableNumber,
      connectedSide: nullableString,
      connectedRouteMeasureM: nullableDecimal,
      isOccupied: boolean,
      recordedNodeAssetId: nullableString,
      matchesDistribution: boolean,
      matchesCompany: boolean,
    })
  ),
  AtlasController_coreMappings: list(
    object({
      id: string,
      source: string,
      note: string,
      createdAt: string,
      nodeAssetId: string,
      nodeName: string,
      cableAId: string,
      cableAName: string,
      coreA: integer,
      cableBId: nullableString,
      cableBName: nullableString,
      coreB: nullableNumber,
      splitterInput: nullableString,
    })
  ),
  AtlasController_createCoreMapping: id,
  AtlasController_deleteCoreMapping: id,
  AtlasController_verifyCoreUsage: object({
    assetId: string,
    source: string,
    note: string,
    verified: boolean,
    verifiedAt: string,
    verifiedBy: string,
    totalCores: integer,
    availableCores: integer,
    bookedCores: integer,
    usedCores: integer,
  }),
  AtlasController_relations: list(relation),
  AtlasController_saveRelations: list(relation),
  AtlasController_setCoreStatus: object({
    assetId: string,
    coreNumber: integer,
    status: string,
  }),
  AtlasController_importNetwork: object({
    bounds,
    firstId: string,
    folderPaths: list(string),
    ftthFolderCount: integer,
    importedCount: integer,
    importId: string,
    segmentCount: integer,
  }),
  AtlasController_importNetworkWorkbook: object({
    importedCount: integer,
    segmentCount: integer,
  }),
  AtlasController_cableNamePattern: pattern,
  AtlasController_setCableNamePattern: pattern,
  AtlasController_notifications: list(
    object({
      id: string,
      title: string,
      message: string,
      bookingId: nullableString,
      readAt: nullableString,
      createdAt: string,
    })
  ),
  AtlasController_markRead: object({ id: string, read: boolean }),
  AtlasController_analyzeConnection: connectionAnalysis,
  AtlasController_analyzeAddress: analysis,
  AtlasController_addressSuggestions: list(
    object({
      id: string,
      label: string,
      category: string,
      location: string,
      longitude: number,
      latitude: number,
      street: string,
      number: string,
      subdistrict: string,
      district: string,
      city: string,
      province: string,
      postalCode: string,
      matchQuality: string,
    })
  ),
  AtlasController_reverseAddress: {
    ...object({
      street: string,
      number: string,
      subdistrict: string,
      district: string,
      city: string,
      province: string,
      postalCode: string,
    }),
    nullable: true,
  },
  AtlasController_bulkAnalysis: object({
    providerAvailable: boolean,
    rows: list(dynamic),
    historyId: string,
  }),
  AtlasController_createBulkJob: job,
  AtlasController_bulkJobProgress: job,
  AtlasController_bulkJobRows: page("rows", row),
  AtlasController_bulkJobMapPoints: list(row),
  AtlasController_expandBulkRow: analysis,
  AtlasController_cancelBulkJob: job,
  AtlasController_analysisHistory: page("items", history),
  AtlasController_surveyCandidates: list(
    object({
      historyId: string,
      rowNumber: integer,
      address: string,
      analysis: dynamic,
      created_at: string,
    })
  ),
  AtlasController_surveys: list(survey),
  AtlasController_createSurvey: id,
  AtlasController_updateSurvey: status,
  AtlasController_analysisHistoryDetail: history,
  AtlasController_deleteAnalysisHistory: object({ success: boolean }),
  AtlasController_routePreview: route,
  AtlasController_ftthRoutePreview: route,
  AuthController_me: user,
  AuthController_createUser: user,
  RegionsController_provinces: list(region),
  RegionsController_cities: list(region),
  RegionsController_districts: list(region),
  RegionsController_subdistricts: list(
    object({ code: string, name: string, postalCode: nullableString })
  ),
  RegionsController_resolve: {
    ...object({
      provinceCode: string,
      cityCode: string,
      districtCode: nullableString,
      subdistrictCode: nullableString,
      postalCode: nullableString,
    }),
    nullable: true,
  },
};

export function addResponseSchemas(document: OpenAPIObject) {
  for (const path of Object.values(document.paths)) {
    if (!path) continue;
    for (const [method, value] of Object.entries(path)) {
      const operation = value as OperationObject;
      if (
        !operation ||
        typeof operation !== "object" ||
        !("responses" in operation)
      )
        continue;
      const schema = operation.operationId && schemas[operation.operationId];
      if (schema) {
        if (
          !Object.keys(operation.responses).some((code) => /^2\d\d$/.test(code))
        ) {
          operation.responses[method === "post" ? "201" : "200"] = {
            description: "Respons berhasil",
          };
        }
        for (const [code, response] of Object.entries(operation.responses)) {
          if (/^2\d\d$/.test(code) && response && !("$ref" in response)) {
            response.description ||= "Respons berhasil";
            response.content = { "application/json": { schema } };
          }
        }
      }
      for (const [code, response] of Object.entries(operation.responses)) {
        if (/^[45]\d\d$/.test(code) && response && !("$ref" in response)) {
          response.content = { "application/json": { schema: error } };
        }
      }
    }
  }
}
