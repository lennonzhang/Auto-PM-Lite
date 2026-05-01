import { Orchestrator } from "./orchestrator/orchestrator.js";
import { openAppServices } from "./service/app-services.js";

export async function openOrchestrator(configPath: string): Promise<Orchestrator> {
  const services = await openAppServices(configPath);
  return services.orchestrator;
}
