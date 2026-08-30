export default async function setup() {
  process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only";
  process.env.COSMOS_ENDPOINT = "https://test.documents.azure.com:443/";
  process.env.COSMOS_KEY = "test-key==";
  process.env.COSMOS_DATABASE = "kinestream-test";
}
