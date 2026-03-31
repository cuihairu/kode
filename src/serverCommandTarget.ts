import { SERVER_COMPONENTS, ServerComponent } from './serverManager';

type ServerCommandTarget = Partial<ServerComponent> & {
  component?: Partial<ServerComponent>;
};

export function resolveServerComponent(target: unknown): ServerComponent | undefined {
  if (!target || typeof target !== 'object') {
    return undefined;
  }

  const candidate = target as ServerCommandTarget;

  if (typeof candidate.name === 'string') {
    return SERVER_COMPONENTS.find(component => component.name === candidate.name);
  }

  if (candidate.component && typeof candidate.component.name === 'string') {
    return SERVER_COMPONENTS.find(component => component.name === candidate.component?.name);
  }

  return undefined;
}
