// Stand-in for vendor/pokemon-data.ts with the same shape as upstream.
import { PokemonColor, PokemonConfig, PokemonExtraSprite, PokemonGeneration } from './types';

const POKEMON_DATA_RAW: Record<string, PokemonConfig> = {
  charizard: {
    id: 6,
    name: 'Charizard',
    generation: PokemonGeneration.Gen1,
    cry: 'Charizard!',
    possibleColors: [PokemonColor.default, PokemonColor.shiny],
  },
  lugia: {
    id: 249,
    name: 'Lugia',
    generation: PokemonGeneration.Gen2,
    cry: 'Lugia!',
    possibleColors: [PokemonColor.default, PokemonColor.shiny],
    originalSpriteSize: 64,
  },
  togekiss: {
    id: 468,
    name: 'Togekiss',
    generation: PokemonGeneration.Gen4,
    cry: 'Togekiss!',
    possibleColors: [PokemonColor.default, PokemonColor.shiny],
    extraSprites: [PokemonExtraSprite.leftFacing],
  },
  missingno: {
    id: 0,
    name: 'MissingNo.',
    generation: PokemonGeneration.Gen1,
    cry: '...',
    possibleColors: [PokemonColor.default],
  },
};

export function getPokemon(key: string): PokemonConfig {
  return POKEMON_DATA_RAW[key];
}
