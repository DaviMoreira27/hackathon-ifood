import { Module } from '@nestjs/common';
import { DietaryService } from './dietary.service.js';
import { DietaryTools } from './dietary.tools.js';

@Module({
  providers: [DietaryService, DietaryTools],
  exports: [DietaryService, DietaryTools],
})
export class DietaryModule {}
