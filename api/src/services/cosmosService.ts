import { CosmosClient, Container, Database } from "@azure/cosmos";
import { CONTAINERS, PARTITION_KEYS } from "../utils/constants";

let client: CosmosClient | null = null;
let database: Database | null = null;

function getClient(): CosmosClient {
  if (!client) {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    if (!endpoint || !key) {
      throw new Error("COSMOS_ENDPOINT and COSMOS_KEY environment variables are required");
    }
    client = new CosmosClient({ endpoint, key });
  }
  return client;
}

async function getDatabase(): Promise<Database> {
  if (!database) {
    const dbName = process.env.COSMOS_DATABASE || "kinestream";
    const { database: db } = await getClient()
      .databases.createIfNotExists({ id: dbName });
    database = db;
  }
  return database;
}

export async function getContainer(containerName: string): Promise<Container> {
  const db = await getDatabase();
  const entry = Object.entries(CONTAINERS).find(([, v]) => v === containerName);
  if (!entry) {
    throw new Error(`Unknown container: "${containerName}". Must be one of: ${Object.values(CONTAINERS).join(", ")}`);
  }
  const partitionKeyPath = PARTITION_KEYS[entry[0] as keyof typeof PARTITION_KEYS];

  const { container } = await db.containers.createIfNotExists({
    id: containerName,
    partitionKey: { paths: [partitionKeyPath] },
  });
  return container;
}
