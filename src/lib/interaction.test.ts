import { describe, it, expect, vi } from 'vitest';
import { InteractionSystem } from './interaction';

describe('InteractionSystem', () => {
    it('should initialize', () => {
        const system = new InteractionSystem();
        expect(system).toBeDefined();
    });

    it('should handle mouse down', () => {
        const system = new InteractionSystem();
        const renderer = {}; // Mock renderer
        // Just verify it doesn't crash for now
        expect(() => system.handleMouseDown(10, 10, renderer)).not.toThrow();
    });
});





